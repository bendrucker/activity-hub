import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../test/fetch-stub";
import { stubQueue } from "../test/queue-stub";
import { SECRETS } from "../test/secrets";
import {
  handleConsumeLog,
  handleReconcile,
  handleWahooBackfill,
  handleWahooIngest,
  handleWahooProbe,
} from "./admin";
import type { StravaIngestMessage, WahooIngestMessage } from "./ingest";
import { StravaClient } from "./strava/client";
import { writeTokens } from "./strava/oauth";
import { WahooClient } from "./wahoo/client";
import { writeTokens as writeWahooTokens } from "./wahoo/oauth";

interface TestEnvOverrides {
  ADMIN_TOKEN?: string;
  INGEST_QUEUE?: Queue;
}

function testEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    ...env,
    ...SECRETS,
    INGEST_QUEUE: stubQueue(),
    ...overrides,
  };
}

function apiClient(stub: FetchStub): StravaClient {
  return new StravaClient({
    apiBase: "https://api.example/api/v3",
    oauth: {
      oauthBase: "https://oauth.example/oauth",
      clientId: "123",
      clientSecret: "shh",
    },
    tokens: env.TOKENS,
    fetchImpl: stub.fetchImpl,
  });
}

function wahooApiClient(stub: FetchStub): WahooClient {
  return new WahooClient({
    apiBase: "https://api.example",
    oauth: {
      oauthBase: "https://api.example/oauth",
      clientId: "123",
      clientSecret: "shh",
    },
    tokens: env.TOKENS,
    fetchImpl: stub.fetchImpl,
  });
}

function reconcileRequest(authorization?: string): Request {
  return new Request("https://hub.example/admin/reconcile", {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

function backfillRequest(authorization?: string, page?: string): Request {
  const url = new URL("https://hub.example/admin/wahoo-backfill");
  if (page !== undefined) {
    url.searchParams.set("page", page);
  }
  return new Request(url, {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

function listResponse(ids: number[]): Response {
  return new Response(JSON.stringify(ids.map((id) => ({ id }))));
}

function workoutsResponse(ids: number[]): Response {
  return new Response(
    JSON.stringify({
      workouts: ids.map((id, index) => ({
        id,
        starts: `2026-07-01T${String(index).padStart(2, "0")}:00:00.000Z`,
        minutes: 60,
        workout_type_id: 0,
        workout_summary: {
          id: id * 10,
          file: { url: `https://cdn/${id}.fit` },
        },
      })),
      total: ids.length,
      page: 1,
      per_page: 30,
    }),
  );
}

beforeEach(async () => {
  await env.TOKENS.delete("strava:tokens");
  await env.TOKENS.delete("wahoo:tokens");
  await writeTokens(env.TOKENS, {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 21_600,
  });
  await writeWahooTokens(env.TOKENS, {
    accessToken: "wat",
    refreshToken: "wrt",
    expiresAt: Math.floor(Date.now() / 1000) + 7200,
  });
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
});

describe("handleReconcile", () => {
  it("rejects a request without an Authorization header", async () => {
    const response = await handleReconcile(reconcileRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("rejects a wrong token", async () => {
    const response = await handleReconcile(
      reconcileRequest("Bearer wrong"),
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects any token when ADMIN_TOKEN is empty", async () => {
    const response = await handleReconcile(
      reconcileRequest("Bearer "),
      testEnv({ ADMIN_TOKEN: "" }),
    );
    expect(response.status).toBe(403);
  });

  it("reconciles and reports the enqueued count", async () => {
    const stub = stubFetch(() => listResponse([101, 102]));
    const queue = stubQueue<StravaIngestMessage>();

    const response = await handleReconcile(
      reconcileRequest("Bearer admin-secret"),
      testEnv({ INGEST_QUEUE: queue }),
      { client: apiClient(stub) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      enqueued: 2,
      refreshed: 0,
    });
    expect(queue.messages.map((message) => message.objectId)).toEqual([
      101, 102,
    ]);
  });

  it("counts a known activity as refreshed rather than enqueued", async () => {
    const now = new Date().toISOString();
    await env.REGISTRY.batch([
      env.REGISTRY.prepare(
        "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES ('activity-101', '2026-07-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?1, ?1)",
      ).bind(now),
      env.REGISTRY.prepare(
        "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES ('strava', '101', 'activity-101', '{}', ?1, ?1)",
      ).bind(now),
    ]);
    const stub = stubFetch(() => listResponse([101, 102]));

    const response = await handleReconcile(
      reconcileRequest("Bearer admin-secret"),
      testEnv(),
      { client: apiClient(stub) },
    );

    expect(await response.json()).toEqual({
      ok: true,
      enqueued: 1,
      refreshed: 1,
    });
  });

  it("reports a Strava rate limit as a 429", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));

    const response = await handleReconcile(
      reconcileRequest("Bearer admin-secret"),
      testEnv(),
      { client: apiClient(stub) },
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("rate limited");
  });

  it("returns the failure to the caller instead of throwing", async () => {
    const stub = stubFetch(() => new Response("boom", { status: 500 }));

    const response = await handleReconcile(
      reconcileRequest("Bearer admin-secret"),
      testEnv(),
      { client: apiClient(stub) },
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      ok: boolean;
      error: string;
      stack?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Strava activity list failed: 500");
    expect(body.stack).toContain("Error");
  });
});

describe("handleWahooBackfill", () => {
  it("rejects a request without an Authorization header", async () => {
    const response = await handleWahooBackfill(backfillRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("rejects a wrong token", async () => {
    const response = await handleWahooBackfill(
      backfillRequest("Bearer wrong"),
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects any token when ADMIN_TOKEN is empty", async () => {
    const response = await handleWahooBackfill(
      backfillRequest("Bearer "),
      testEnv({ ADMIN_TOKEN: "" }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a page that is not a positive integer", async () => {
    const response = await handleWahooBackfill(
      backfillRequest("Bearer admin-secret", "zero"),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("enqueues a short page and reports the walk as done", async () => {
    const stub = stubFetch(() => workoutsResponse([101, 102]));
    const queue = stubQueue<WahooIngestMessage>();

    const response = await handleWahooBackfill(
      backfillRequest("Bearer admin-secret"),
      testEnv({ INGEST_QUEUE: queue }),
      { client: wahooApiClient(stub) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pagesFetched: 1,
      workoutsSeen: 2,
      enqueued: 2,
      oldestStartedAt: "2026-07-01T00:00:00.000Z",
      done: true,
    });
    expect(queue.messages.map((message) => message.workoutId)).toEqual([
      101, 102,
    ]);
  });

  it("hands the caller the next page when the run stops short of the end", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => index + 1);
    const stub = stubFetch(() => workoutsResponse(ids));

    const response = await handleWahooBackfill(
      backfillRequest("Bearer admin-secret", "3"),
      testEnv(),
      { client: wahooApiClient(stub), pages: 1 },
    );

    expect(await response.json()).toMatchObject({
      pagesFetched: 1,
      workoutsSeen: 30,
      done: false,
      nextPage: 4,
    });
    expect(new URL(stub.requests[0]!.url).searchParams.get("page")).toBe("3");
  });

  it("reports a Wahoo rate limit as a 429", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));

    const response = await handleWahooBackfill(
      backfillRequest("Bearer admin-secret"),
      testEnv(),
      { client: wahooApiClient(stub) },
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("rate limited");
  });

  it("returns the failure to the caller instead of throwing", async () => {
    const stub = stubFetch(() => new Response("boom", { status: 500 }));

    const response = await handleWahooBackfill(
      backfillRequest("Bearer admin-secret"),
      testEnv(),
      { client: wahooApiClient(stub) },
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("500");
  });
});

describe("handleWahooProbe", () => {
  function probeRequest(authorization?: string, workout?: string): Request {
    const url = new URL("https://hub.example/admin/wahoo-probe");
    if (workout !== undefined) {
      url.searchParams.set("workout", workout);
    }
    return new Request(url, {
      headers: authorization ? { Authorization: authorization } : {},
    });
  }

  it("rejects a request without an Authorization header", async () => {
    const response = await handleWahooProbe(probeRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("rejects a workout that is not a positive integer", async () => {
    const response = await handleWahooProbe(
      probeRequest("Bearer admin-secret", "abc"),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("reports both fetch statuses and the guard verdict", async () => {
    const workout = {
      id: 101,
      starts: "2018-01-15T14:10:09.000Z",
      minutes: 60,
      workout_type_id: 0,
    };
    const stub = stubFetch((input) =>
      String(input instanceof Request ? input.url : input).endsWith(
        "/workout_summary",
      )
        ? new Response(
            JSON.stringify({ id: 1010, file: { url: "https://cdn/101.fit" } }),
          )
        : new Response(JSON.stringify(workout)),
    );

    const response = await handleWahooProbe(
      probeRequest("Bearer admin-secret", "101"),
      testEnv(),
      { client: wahooApiClient(stub) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workout: { status: number };
      summary: { status: number };
      guardPassed: boolean | null;
    };
    expect(body.workout.status).toBe(200);
    expect(body.summary.status).toBe(200);
    expect(body.guardPassed).toBe(true);
  });

  it("passes through an upstream error status with its body", async () => {
    const stub = stubFetch(() => new Response("Not Found", { status: 404 }));

    const response = await handleWahooProbe(
      probeRequest("Bearer admin-secret", "101"),
      testEnv(),
      { client: wahooApiClient(stub) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      summary: { status: number; body: string };
      guardPassed: boolean | null;
    };
    expect(body.summary.status).toBe(404);
    expect(body.summary.body).toBe("Not Found");
    expect(body.guardPassed).toBeNull();
  });
});

describe("handleWahooIngest", () => {
  function ingestRequest(authorization?: string, workout?: string): Request {
    const url = new URL("https://hub.example/admin/wahoo-ingest");
    if (workout !== undefined) {
      url.searchParams.set("workout", workout);
    }
    return new Request(url, {
      method: "POST",
      headers: authorization ? { Authorization: authorization } : {},
    });
  }

  it("rejects a request without an Authorization header", async () => {
    const response = await handleWahooIngest(ingestRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("rejects a workout that is not a positive integer", async () => {
    const response = await handleWahooIngest(
      ingestRequest("Bearer admin-secret", "abc"),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("ingests one workout end to end and reports the registry row", async () => {
    const workout = {
      id: 101,
      starts: "2018-01-15T14:10:09.000Z",
      minutes: 60,
      workout_type_id: 0,
      workout_summary: { id: 1010 },
    };
    const stub = stubFetch((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/workout_summary")) {
        return new Response(
          JSON.stringify({
            id: 1010,
            duration_total_accum: "3600.0",
            file: { url: "https://cdn.example/101.fit" },
          }),
        );
      }
      if (url.startsWith("https://cdn.example/")) {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      return new Response(JSON.stringify(workout));
    });

    const response = await handleWahooIngest(
      ingestRequest("Bearer admin-secret", "101"),
      testEnv(),
      { client: wahooApiClient(stub), fetchImpl: stub.fetchImpl },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ingested: true });
    const row = await env.REGISTRY.prepare(
      "SELECT source_id FROM activity_sources WHERE source = 'wahoo' AND source_id = '101'",
    ).first<{ source_id: string }>();
    expect(row?.source_id).toBe("101");
  });

  it("reports a missing workout as a 404", async () => {
    const stub = stubFetch(() => new Response("nope", { status: 404 }));

    const response = await handleWahooIngest(
      ingestRequest("Bearer admin-secret", "101"),
      testEnv(),
      { client: wahooApiClient(stub) },
    );

    expect(response.status).toBe(404);
  });
});

describe("handleConsumeLog", () => {
  function logRequest(authorization?: string): Request {
    return new Request("https://hub.example/admin/consume-log", {
      headers: authorization ? { Authorization: authorization } : {},
    });
  }

  it("rejects a request without an Authorization header", async () => {
    const response = await handleConsumeLog(logRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("returns the stored trail", async () => {
    const entry = {
      at: "2026-08-04T00:00:00.000Z",
      source: "wahoo",
      kind: "workout",
      id: 101,
      outcome: "ok",
    };
    await env.TOKENS.put("debug:consume-log", JSON.stringify([entry]));

    const response = await handleConsumeLog(
      logRequest("Bearer admin-secret"),
      testEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([entry]);
  });
});
