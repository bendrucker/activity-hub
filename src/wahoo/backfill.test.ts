import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { stubQueue, type QueueStub } from "../../test/queue-stub";
import { SECRETS } from "../../test/secrets";
import { RateLimitedError, type WahooIngestMessage } from "../ingest";
import {
  backfillWahooWorkouts,
  PAGES_PER_RUN,
  PER_PAGE,
  REQUEST_BUDGET,
} from "./backfill";
import { WahooClient } from "./client";
import { writeTokens } from "./oauth";

function testEnv(queue: QueueStub<WahooIngestMessage>): Env {
  return { ...env, ...SECRETS, INGEST_QUEUE: queue };
}

function apiClient(stub: FetchStub): WahooClient {
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

interface WorkoutOptions {
  starts?: string;
  summary?: boolean;
}

function workout(id: number, options: WorkoutOptions = {}) {
  const { starts = "2026-07-01T14:00:00.000Z", summary = true } = options;
  return {
    id,
    starts,
    minutes: 60,
    workout_type_id: 0,
    name: `workout ${id}`,
    ...(summary ? { workout_summary: summaryPayload(id) } : {}),
  };
}

function summaryPayload(id: number) {
  return {
    id: id * 10,
    duration_total_accum: "3600.0",
    file: { url: `https://cdn.example/${id}.fit` },
  };
}

function listResponse(
  workouts: unknown[],
  perPage: number = PER_PAGE,
): Response {
  return new Response(
    JSON.stringify({
      workouts,
      total: workouts.length,
      page: 1,
      per_page: perPage,
      order: "descending",
      sort: "starts",
    }),
  );
}

function fullPage(page: number): unknown[] {
  return Array.from({ length: PER_PAGE }, (_, index) =>
    workout(page * 100 + index),
  );
}

function requestedPage(request: Request): number {
  return Number(new URL(request.url).searchParams.get("page"));
}

async function insertWahooSource(sourceId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.REGISTRY.batch([
    env.REGISTRY.prepare(
      "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES (?1, '2026-07-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?2, ?2)",
    ).bind(`activity-${sourceId}`, now),
    env.REGISTRY.prepare(
      "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES ('wahoo', ?1, ?2, '{}', ?3, ?3)",
    ).bind(sourceId, `activity-${sourceId}`, now),
  ]);
}

beforeEach(async () => {
  await env.TOKENS.delete("wahoo:tokens");
  await writeTokens(env.TOKENS, {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 7200,
  });
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
});

describe("backfillWahooWorkouts", () => {
  it("enqueues an ingest message per workout, rebuilt into the webhook shape", async () => {
    const stub = stubFetch(() => listResponse([workout(101)]));
    const queue = stubQueue<WahooIngestMessage>();

    const result = await backfillWahooWorkouts(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(result).toEqual({
      pagesFetched: 1,
      workoutsSeen: 1,
      enqueued: 1,
      apiRequests: 1,
      oldestStartedAt: "2026-07-01T14:00:00.000Z",
      done: true,
    });
    expect(queue.messages).toEqual([
      {
        source: "wahoo",
        kind: "workout_summary",
        workoutId: 101,
        summary: {
          ...summaryPayload(101),
          workout: {
            id: 101,
            starts: "2026-07-01T14:00:00.000Z",
            minutes: 60,
            workout_type_id: 0,
            name: "workout 101",
          },
        },
      },
    ]);

    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe("/v1/workouts");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe(String(PER_PAGE));
  });

  it("skips workouts already present in activity_sources", async () => {
    await insertWahooSource("101");
    const stub = stubFetch(() => listResponse([workout(101), workout(102)]));
    const queue = stubQueue<WahooIngestMessage>();

    const result = await backfillWahooWorkouts(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(result.workoutsSeen).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(queue.messages.map((message) => message.workoutId)).toEqual([102]);
  });

  it("fetches the workout_summary endpoint when the list entry omits it", async () => {
    const stub = stubFetch((request) => {
      const { pathname } = new URL(request.url);
      return pathname === "/v1/workouts"
        ? listResponse([workout(101, { summary: false })])
        : new Response(JSON.stringify(summaryPayload(101)));
    });
    const queue = stubQueue<WahooIngestMessage>();

    const result = await backfillWahooWorkouts(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(result.enqueued).toBe(1);
    expect(result.apiRequests).toBe(2);
    expect(new URL(stub.requests[1]!.url).pathname).toBe(
      "/v1/workouts/101/workout_summary",
    );
    expect(queue.messages[0]?.summary.file.url).toBe(
      "https://cdn.example/101.fit",
    );
  });

  it("skips a workout whose summary is missing entirely", async () => {
    const stub = stubFetch((request) =>
      new URL(request.url).pathname === "/v1/workouts"
        ? listResponse([workout(101, { summary: false })])
        : new Response("not found", { status: 404 }),
    );
    const queue = stubQueue<WahooIngestMessage>();

    const result = await backfillWahooWorkouts(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(result.workoutsSeen).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it("reports the next page when a full page ends the run's page budget", async () => {
    const stub = stubFetch((request) =>
      listResponse(fullPage(requestedPage(request))),
    );
    const queue = stubQueue<WahooIngestMessage>();

    const result = await backfillWahooWorkouts(testEnv(queue), {
      client: apiClient(stub),
      pages: 2,
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.workoutsSeen).toBe(PER_PAGE * 2);
    expect(result.done).toBe(false);
    expect(result.nextPage).toBe(3);
    expect(stub.requests.map((request) => requestedPage(request))).toEqual([
      1, 2,
    ]);
  });

  it("resumes from the requested page", async () => {
    const stub = stubFetch(() => listResponse([workout(101)]));

    const result = await backfillWahooWorkouts(
      testEnv(stubQueue<WahooIngestMessage>()),
      {
        client: apiClient(stub),
        page: 7,
      },
    );

    expect(requestedPage(stub.requests[0]!)).toBe(7);
    expect(result.done).toBe(true);
  });

  it("stops on a short page and reports the oldest start seen", async () => {
    const stub = stubFetch((request) =>
      requestedPage(request) === 1
        ? listResponse(fullPage(1))
        : listResponse([
            workout(999, { starts: "2019-03-04T15:00:00.000Z" }),
            workout(998, { starts: "2018-11-20T15:00:00.000Z" }),
          ]),
    );
    const queue = stubQueue<WahooIngestMessage>();

    const result = await backfillWahooWorkouts(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(result.done).toBe(true);
    expect(result.nextPage).toBeUndefined();
    expect(result.pagesFetched).toBe(2);
    expect(result.oldestStartedAt).toBe("2018-11-20T15:00:00.000Z");
    expect(queue.messages).toHaveLength(PER_PAGE + 2);
  });

  it("stops on the request budget before the page budget when summaries cost a call each", async () => {
    const stub = stubFetch((request) =>
      new URL(request.url).pathname === "/v1/workouts"
        ? listResponse(
            fullPage(requestedPage(request)).map((entry) => ({
              ...(entry as Record<string, unknown>),
              workout_summary: undefined,
            })),
          )
        : new Response("not found", { status: 404 }),
    );

    const result = await backfillWahooWorkouts(
      testEnv(stubQueue<WahooIngestMessage>()),
      {
        client: apiClient(stub),
      },
    );

    expect(result.pagesFetched).toBeLessThan(PAGES_PER_RUN);
    expect(result.apiRequests).toBeGreaterThanOrEqual(REQUEST_BUDGET);
    expect(result.nextPage).toBe(result.pagesFetched + 1);
  });

  it("throws RateLimitedError on a 429", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));

    await expect(
      backfillWahooWorkouts(testEnv(stubQueue<WahooIngestMessage>()), {
        client: apiClient(stub),
      }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("throws on a non-429 list error", async () => {
    const stub = stubFetch(() => new Response("boom", { status: 500 }));

    await expect(
      backfillWahooWorkouts(testEnv(stubQueue<WahooIngestMessage>()), {
        client: apiClient(stub),
      }),
    ).rejects.toThrow("Wahoo workout list failed: 500");
  });
});
