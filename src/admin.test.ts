import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../test/fetch-stub";
import { stubQueue } from "../test/queue-stub";
import { SECRETS } from "../test/secrets";
import { handleReconcile, handleWahooBackfill } from "./admin";
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
});
