import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { RateLimitedError, type IngestMessage } from "../ingest";
import { StravaClient } from "./client";
import { writeTokens } from "./oauth";
import {
  LOOKBACK_OVERLAP_S,
  PER_PAGE,
  reconcileStravaActivities,
} from "./reconcile";

interface QueueStub extends Queue<IngestMessage> {
  messages: IngestMessage[];
}

function stubQueue(): QueueStub {
  const messages: IngestMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(batch) {
      for (const item of batch) {
        messages.push(item.body);
      }
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
}

function testEnv(queue: QueueStub): Env {
  return {
    ...env,
    ADMIN_TOKEN: "admin-secret",
    STRAVA_CLIENT_SECRET: "shh",
    STRAVA_VERIFY_TOKEN: "verify-me",
    INGEST_QUEUE: queue,
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
  await env.TOKENS.delete("strava:tokens");
  await writeTokens(env.TOKENS, {
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
    const queue = stubQueue();

    const enqueued = await reconcileStravaActivities(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(enqueued).toBe(2);
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

  it("skips ids already present in activity_sources", async () => {
    await insertStravaSource("101", "2026-07-01T14:00:00.000Z");
    const stub = stubFetch(() => listResponse([101, 102]));
    const queue = stubQueue();

    const enqueued = await reconcileStravaActivities(testEnv(queue), {
      client: apiClient(stub),
    });

    expect(enqueued).toBe(1);
    expect(queue.messages.map((message) => message.objectId)).toEqual([102]);
  });

  it("lists after the max started_at minus the overlap window", async () => {
    const startedAt = "2026-07-15T12:00:00.000Z";
    await insertStravaSource("101", "2026-07-01T14:00:00.000Z");
    await insertStravaSource("102", startedAt);
    const stub = stubFetch(() => listResponse([]));

    await reconcileStravaActivities(testEnv(stubQueue()), {
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
    const queue = stubQueue();

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
      reconcileStravaActivities(testEnv(stubQueue()), {
        client: apiClient(stub),
      }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("throws on a non-429 error response", async () => {
    const stub = stubFetch(() => new Response("boom", { status: 500 }));

    await expect(
      reconcileStravaActivities(testEnv(stubQueue()), {
        client: apiClient(stub),
      }),
    ).rejects.toThrow("Strava activity list failed: 500");
  });
});
