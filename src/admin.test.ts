import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTokens } from "../test/broker";
import { stubFetch, type FetchStub } from "../test/fetch-stub";
import { stubQueue } from "../test/queue-stub";
import { SECRETS } from "../test/secrets";
import {
  handleConsumeLog,
  handlePipeline,
  handleReconcile,
  handleStravaBackfill,
  handleWahooBackfill,
  handleWahooIngest,
  handleWahooProbe,
} from "./admin";
import {
  ARTIFACT_VERSION,
  MAX_ATTEMPTS,
  type DerivedStatus,
  type Stage,
} from "./derived";
import type { StravaIngestMessage, WahooIngestMessage } from "./ingest";
import { StravaClient } from "./strava/client";
import { tokenBroker } from "./tokens/broker";
import { WahooClient } from "./wahoo/client";

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
    tokens: tokenBroker(env, "strava"),
    fetch: stub.fetch,
  });
}

function wahooApiClient(stub: FetchStub): WahooClient {
  return new WahooClient({
    apiBase: "https://api.example",
    tokens: tokenBroker(env, "wahoo"),
    fetch: stub.fetch,
  });
}

function reconcileRequest(authorization?: string): Request {
  return new Request("https://hub.example/admin/reconcile", {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

function stravaBackfillRequest(
  authorization?: string,
  cursor?: string,
): Request {
  const url = new URL("https://hub.example/admin/strava-backfill");
  if (cursor !== undefined) {
    url.searchParams.set("cursor", cursor);
  }
  return new Request(url, {
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
  await clearTokens("strava");
  await clearTokens("wahoo");
  await tokenBroker(env, "strava").store({
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 21_600,
  });
  await tokenBroker(env, "wahoo").store({
    accessToken: "wat",
    refreshToken: "wrt",
    expiresAt: Math.floor(Date.now() / 1000) + 7200,
  });
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM derived"),
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
});

describe("handleStravaBackfill", () => {
  it("rejects a request without an Authorization header", async () => {
    const response = await handleStravaBackfill(
      stravaBackfillRequest(),
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("enqueues refreshes for rows with nothing archived", async () => {
    const now = new Date().toISOString();
    await env.REGISTRY.batch([
      env.REGISTRY.prepare(
        "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES ('activity-101', '2018-07-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?1, ?1)",
      ).bind(now),
      env.REGISTRY.prepare(
        "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES ('strava', '101', 'activity-101', '{}', ?1, ?1)",
      ).bind(now),
    ]);
    const queue = stubQueue<StravaIngestMessage>();

    const response = await handleStravaBackfill(
      stravaBackfillRequest("Bearer admin-secret"),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enqueued: 1,
      remaining: 1,
      done: true,
    });
    expect(queue.messages).toEqual([
      { source: "strava", kind: "refresh", objectId: 101 },
    ]);
  });

  it("passes the cursor through", async () => {
    const queue = stubQueue<StravaIngestMessage>();

    const response = await handleStravaBackfill(
      stravaBackfillRequest("Bearer admin-secret", "500"),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([]);
  });
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
      { client: wahooApiClient(stub), fetch: stub.fetch },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      ingested: true,
      outcome: "ok",
    });
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

describe("handlePipeline", () => {
  const OLDEST = "2026-01-01T00:00:00.000Z";
  const NEWER = "2026-02-01T00:00:00.000Z";
  const RECORDED = "2099-01-01T00:00:00.000Z";

  interface StageSummaryBody {
    stage: Stage;
    total: number;
    statuses: Record<DerivedStatus, number>;
    parked: number;
    oldestStale: {
      activityId: string;
      sourceUpdatedAt: string;
      behindS: number | null;
    } | null;
  }

  interface PipelineBody {
    ok: boolean;
    generatedAt: string;
    stages: StageSummaryBody[];
    failures: {
      activityId: string;
      stage: Stage;
      error: string | null;
      attempts: number;
      updatedAt: string;
    }[];
  }

  function pipelineRequest(authorization?: string): Request {
    return new Request("https://hub.example/admin/pipeline", {
      headers: authorization ? { Authorization: authorization } : {},
    });
  }

  async function seedActivity(
    activityId: string,
    sourceUpdatedAt: string,
  ): Promise<void> {
    await env.REGISTRY.batch([
      env.REGISTRY.prepare(
        `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at)
         VALUES (?1, '2026-01-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?2, ?2)`,
      ).bind(activityId, sourceUpdatedAt),
      env.REGISTRY.prepare(
        `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at)
         VALUES ('wahoo', ?1, ?1, '{}', ?2, ?2)`,
      ).bind(activityId, sourceUpdatedAt),
    ]);
  }

  interface SeedDerived {
    activityId: string;
    stage: Stage;
    status: DerivedStatus;
    attempts?: number;
    error?: string;
  }

  async function seedDerived(seed: SeedDerived): Promise<void> {
    await env.REGISTRY.prepare(
      `INSERT INTO derived (activity_id, stage, input_fingerprint, output_key, status, attempts, error, updated_at, artifact_version)
       VALUES (?1, ?2, 'fingerprint', NULL, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        seed.activityId,
        seed.stage,
        seed.status,
        seed.attempts ?? 0,
        seed.error ?? null,
        RECORDED,
        ARTIFACT_VERSION[seed.stage],
      )
      .run();
  }

  function stageOf(body: PipelineBody, stage: Stage): StageSummaryBody {
    const summary = body.stages.find((entry) => entry.stage === stage);
    expect(summary).toBeDefined();
    return summary!;
  }

  it("rejects a request without an Authorization header", async () => {
    const response = await handlePipeline(pipelineRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("rejects a wrong token", async () => {
    const response = await handlePipeline(
      pipelineRequest("Bearer wrong"),
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("reports every stage as zero when nothing has been derived", async () => {
    const response = await handlePipeline(
      pipelineRequest("Bearer admin-secret"),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as PipelineBody;
    expect(body.ok).toBe(true);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.stages).toEqual([
      {
        stage: "decode",
        total: 0,
        statuses: { ok: 0, failed: 0, skipped: 0 },
        parked: 0,
        oldestStale: null,
      },
      {
        stage: "lake",
        total: 0,
        statuses: { ok: 0, failed: 0, skipped: 0 },
        parked: 0,
        oldestStale: null,
      },
      {
        stage: "publish",
        total: 0,
        statuses: { ok: 0, failed: 0, skipped: 0 },
        parked: 0,
        oldestStale: null,
      },
    ]);
    expect(body.failures).toEqual([]);
  });

  it("counts each stage and names the oldest stale activity", async () => {
    await seedActivity("a1", OLDEST);
    await seedActivity("a2", NEWER);
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });
    await seedDerived({
      activityId: "a2",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS,
      error: "no decodable raw key",
    });
    await seedDerived({ activityId: "a1", stage: "lake", status: "skipped" });

    const response = await handlePipeline(
      pipelineRequest("Bearer admin-secret"),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as PipelineBody;

    // Both decode rows are current and the failed one has spent its attempts,
    // so nothing there is waiting to be picked up. `parked` is what keeps that
    // from reading as caught up: one activity is stuck until someone moves it.
    expect(stageOf(body, "decode")).toEqual({
      stage: "decode",
      total: 2,
      statuses: { ok: 1, failed: 1, skipped: 0 },
      parked: 1,
      oldestStale: null,
    });

    // Neither stage is swept, so neither reports a stale activity. Answering
    // for them would name every activity in the registry, which reads as a
    // backlog rather than as a stage nothing enqueues.
    const lake = stageOf(body, "lake");
    expect(lake.total).toBe(1);
    expect(lake.statuses).toEqual({ ok: 0, failed: 0, skipped: 1 });
    expect(lake.oldestStale).toBeNull();

    const publish = stageOf(body, "publish");
    expect(publish.total).toBe(0);
    expect(publish.oldestStale).toBeNull();

    expect(body.failures).toEqual([
      {
        activityId: "a2",
        stage: "decode",
        error: "no decodable raw key",
        attempts: MAX_ATTEMPTS,
        updatedAt: RECORDED,
      },
    ]);
  });

  // Same stage, same failed count, one attempt short of the ceiling. The only
  // thing separating "retries on the next sweep" from "stuck" is this number.
  it("leaves a failure under the ceiling unparked", async () => {
    await seedActivity("a1", OLDEST);
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS - 1,
      error: "no decodable raw key",
    });

    const response = await handlePipeline(
      pipelineRequest("Bearer admin-secret"),
      testEnv(),
    );

    const body = (await response.json()) as PipelineBody;
    const decode = stageOf(body, "decode");
    expect(decode.statuses.failed).toBe(1);
    expect(decode.parked).toBe(0);
    expect(decode.oldestStale).toMatchObject({ activityId: "a1" });
    expect(body.failures[0]?.attempts).toBe(MAX_ATTEMPTS - 1);
  });

  it("ages the oldest stale activity in seconds", async () => {
    await seedActivity("a1", OLDEST);
    const expected = Math.round((Date.now() - Date.parse(OLDEST)) / 1000);

    const response = await handlePipeline(
      pipelineRequest("Bearer admin-secret"),
      testEnv(),
    );

    const body = (await response.json()) as PipelineBody;
    expect(stageOf(body, "decode").oldestStale?.behindS).toBeCloseTo(
      expected,
      -1,
    );
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
