import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTokens } from "../../test/broker";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { stubQueue, type QueueStub } from "../../test/queue-stub";
import { SECRETS } from "../../test/secrets";
import { RateLimitedError, type StravaIngestMessage } from "../ingest";
import { tokenBroker } from "../tokens/broker";
import { StravaClient } from "./client";
import {
  LOOKBACK_OVERLAP_S,
  PER_PAGE,
  reconcileStravaActivities,
} from "./reconcile";

function testEnv(queue: QueueStub<StravaIngestMessage>): Env {
  return {
    ...env,
    ...SECRETS,
    INGEST_QUEUE: queue,
  };
}

function apiClient(stub: FetchStub): StravaClient {
  return new StravaClient({
    apiBase: "https://api.example/api/v3",
    tokens: tokenBroker(env, "strava"),
    fetch: stub.fetch,
  });
}

function listResponse(ids: number[]): Response {
  return new Response(JSON.stringify(ids.map((id) => ({ id }))));
}

async function insertStravaSource(
  sourceId: string,
  startedAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.REGISTRY.batch([
    env.REGISTRY.prepare(
      "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES (?1, ?2, 'America/Los_Angeles', 'ride', 3600, ?3, ?3)",
    ).bind(`activity-${sourceId}`, startedAt, now),
    env.REGISTRY.prepare(
      "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES ('strava', ?1, ?2, '{}', ?3, ?3)",
    ).bind(sourceId, `activity-${sourceId}`, now),
  ]);
}

beforeEach(async () => {
  await clearTokens("strava");
  await tokenBroker(env, "strava").store({
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 21_600,
  });
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
});

describe("reconcileStravaActivities", () => {
  it("enqueues a create message for each listed activity on an empty registry", async () => {
    const stub = stubFetch(() => listResponse([101, 102]));
    const queue = stubQueue<StravaIngestMessage>();

    await reconcileStravaActivities(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(queue.messages).toEqual([
      {
        source: "strava",
        kind: "create",
        objectType: "activity",
        objectId: 101,
        updates: {},
      },
      {
        source: "strava",
        kind: "create",
        objectType: "activity",
        objectId: 102,
        updates: {},
      },
    ]);

    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe("/api/v3/athlete/activities");
    expect(url.searchParams.get("per_page")).toBe(String(PER_PAGE));
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("after")).toBeNull();
  });

  it("enqueues a refresh for ids already present in activity_sources", async () => {
    await insertStravaSource("101", "2026-07-01T14:00:00.000Z");
    const stub = stubFetch(() => listResponse([101, 102]));
    const queue = stubQueue<StravaIngestMessage>();

    const report = await reconcileStravaActivities(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(queue.messages).toEqual([
      { source: "strava", kind: "refresh", objectId: 101 },
      {
        source: "strava",
        kind: "create",
        objectType: "activity",
        objectId: 102,
        updates: {},
      },
    ]);
    expect(report).toEqual({ enqueued: 1, refreshed: 1 });
  });

  it("refreshes only the known activities Strava lists inside the window", async () => {
    // The lookback runs 30 days back from the newest ingested activity, so
    // May 1 is outside a window that starts June 15.
    await insertStravaSource("101", "2026-05-01T14:00:00.000Z");
    await insertStravaSource("102", "2026-07-15T12:00:00.000Z");
    const stub = stubFetch((request) => {
      const after = Number(new URL(request.url).searchParams.get("after"));
      return listResponse(
        [
          { id: 101, startedAt: "2026-05-01T14:00:00.000Z" },
          { id: 102, startedAt: "2026-07-15T12:00:00.000Z" },
        ]
          .filter(({ startedAt }) => Date.parse(startedAt) / 1000 > after)
          .map(({ id }) => id),
      );
    });
    const queue = stubQueue<StravaIngestMessage>();

    const report = await reconcileStravaActivities(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(queue.messages).toEqual([
      { source: "strava", kind: "refresh", objectId: 102 },
    ]);
    expect(report).toEqual({ enqueued: 0, refreshed: 1 });
  });

  it("lists after the max started_at minus the overlap window", async () => {
    const startedAt = "2026-07-15T12:00:00.000Z";
    await insertStravaSource("101", "2026-07-01T14:00:00.000Z");
    await insertStravaSource("102", startedAt);
    const stub = stubFetch(() => listResponse([]));

    await reconcileStravaActivities(testEnv(stubQueue<StravaIngestMessage>()), {
      client: apiClient(stub),
    });

    const url = new URL(stub.requests[0]!.url);
    expect(url.searchParams.get("after")).toBe(
      String(Date.parse(startedAt) / 1000 - LOOKBACK_OVERLAP_S),
    );
  });

  it("pages until a short page", async () => {
    const fullPage = Array.from({ length: PER_PAGE }, (_, i) => i + 1);
    const stub = stubFetch((request) => {
      const page = new URL(request.url).searchParams.get("page");
      return page === "1" ? listResponse(fullPage) : listResponse([999]);
    });
    const queue = stubQueue<StravaIngestMessage>();

    await reconcileStravaActivities(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(stub.requests).toHaveLength(2);
    expect(new URL(stub.requests[1]!.url).searchParams.get("page")).toBe("2");
    expect(queue.messages).toHaveLength(PER_PAGE + 1);
    expect(queue.messages.at(-1)?.objectId).toBe(999);
  });

  it("throws RateLimitedError on a 429", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));

    await expect(
      reconcileStravaActivities(testEnv(stubQueue<StravaIngestMessage>()), {
        client: apiClient(stub),
      }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("throws on a non-429 error response", async () => {
    const stub = stubFetch(() => new Response("boom", { status: 500 }));

    await expect(
      reconcileStravaActivities(testEnv(stubQueue<StravaIngestMessage>()), {
        client: apiClient(stub),
      }),
    ).rejects.toThrow("Strava activity list failed: 500");
  });
});
