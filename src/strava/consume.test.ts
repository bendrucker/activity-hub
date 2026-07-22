import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { RateLimitedError, type IngestMessage } from "../ingest";
import { StravaClient } from "./client";
import { consumeStravaEvent } from "./consume";
import { writeTokens } from "./oauth";

const testEnv: Env = {
  ...env,
  STRAVA_CLIENT_SECRET: "shh",
  STRAVA_VERIFY_TOKEN: "verify-me",
};

const ACTIVITY_ID = 42;

const DETAIL_JSON = JSON.stringify({
  id: ACTIVITY_ID,
  name: "Morning Gravel",
  sport_type: "GravelRide",
  start_date: "2026-07-01T14:00:00Z",
  elapsed_time: 3600,
  timezone: "(GMT-08:00) America/Los_Angeles",
});

const STREAMS_JSON = JSON.stringify({
  time: { data: [0, 1, 2] },
  distance: { data: [0, 1.2, 2.4] },
});

const PHOTOS_JSON = JSON.stringify([
  {
    unique_id: "photo-1",
    urls: {
      "100": "https://cdn.example/100.jpg",
      "5000": "https://cdn.example/5000.jpg",
    },
  },
]);

function message(overrides: Partial<IngestMessage> = {}): IngestMessage {
  return {
    source: "strava",
    kind: "create",
    objectType: "activity",
    objectId: ACTIVITY_ID,
    updates: {},
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

function detailKey(id: number): string {
  return `raw/strava/activities/${id}/detail.json`;
}

function streamsKey(id: number): string {
  return `raw/strava/activities/${id}/streams.json`;
}

async function sourceRow(
  sourceId: string,
): Promise<Record<string, unknown> | null> {
  return env.REGISTRY.prepare(
    "SELECT * FROM activity_sources WHERE source = 'strava' AND source_id = ?1",
  )
    .bind(sourceId)
    .first();
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
  const existing = await env.RAW.list({
    prefix: `raw/strava/activities/${ACTIVITY_ID}/`,
  });
  await Promise.all(
    existing.objects.map((object) => env.RAW.delete(object.key)),
  );
});

function respondByPath(
  routes: Record<string, () => Response>,
): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);
    for (const [path, respond] of Object.entries(routes)) {
      if (url.pathname === path) {
        return respond();
      }
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };
}

describe("consumeStravaEvent", () => {
  it("writes detail, streams, and photos and mints a registry activity on create", async () => {
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response(STREAMS_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () =>
          new Response(PHOTOS_JSON),
      }),
    );
    const photoStub = stubFetch(() => new Response(new Uint8Array([1, 2, 3])));

    await consumeStravaEvent(message(), testEnv, {
      client: apiClient(stub),
      fetchImpl: photoStub.fetchImpl,
    });

    const storedDetail = await env.RAW.get(detailKey(ACTIVITY_ID));
    expect(await storedDetail?.text()).toBe(DETAIL_JSON);

    const storedStreams = await env.RAW.get(streamsKey(ACTIVITY_ID));
    expect(await storedStreams?.text()).toBe(STREAMS_JSON);

    const storedPhoto = await env.RAW.get(
      `raw/strava/activities/${ACTIVITY_ID}/photos/photo-1.jpg`,
    );
    expect(storedPhoto).not.toBeNull();
    expect(photoStub.requests[0]!.url).toBe("https://cdn.example/5000.jpg");

    const row = await sourceRow(String(ACTIVITY_ID));
    expect(row).toMatchObject({
      raw_keys: JSON.stringify({
        detail: detailKey(ACTIVITY_ID),
        streams: streamsKey(ACTIVITY_ID),
        photos: `raw/strava/activities/${ACTIVITY_ID}/photos/`,
      }),
    });

    const activity = await env.REGISTRY.prepare(
      "SELECT * FROM activities WHERE activity_id = ?1",
    )
      .bind(row!.activity_id as string)
      .first();
    expect(activity).toMatchObject({
      sport: "ride",
      timezone: "America/Los_Angeles",
      started_at: "2026-07-01T14:00:00.000Z",
      duration_s: 3600,
    });
  });

  it("still writes detail and streams and upserts when photos fetch returns 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response(STREAMS_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () =>
          new Response("boom", { status: 500 }),
      }),
    );

    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });

    expect(await env.RAW.get(detailKey(ACTIVITY_ID))).not.toBeNull();
    expect(await env.RAW.get(streamsKey(ACTIVITY_ID))).not.toBeNull();
    const row = await sourceRow(String(ACTIVITY_ID));
    expect(JSON.parse(row!.raw_keys as string)).not.toHaveProperty("photos");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("omits streams.json and its rawKeys entry on a 404", async () => {
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response("not found", { status: 404 }),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () => new Response("[]"),
      }),
    );

    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });

    expect(await env.RAW.get(streamsKey(ACTIVITY_ID))).toBeNull();
    const row = await sourceRow(String(ACTIVITY_ID));
    expect(JSON.parse(row!.raw_keys as string)).not.toHaveProperty("streams");
  });

  it("writes nothing and warns on a detail 404", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = stubFetch(() => new Response("not found", { status: 404 }));

    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });

    expect(await env.RAW.get(detailKey(ACTIVITY_ID))).toBeNull();
    expect(await sourceRow(String(ACTIVITY_ID))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is a no-op on a duplicate create delivery", async () => {
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response(STREAMS_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () =>
          new Response(PHOTOS_JSON),
      }),
    );
    const photoStub = stubFetch(() => new Response(new Uint8Array([1])));
    const options = { client: apiClient(stub), fetchImpl: photoStub.fetchImpl };

    await consumeStravaEvent(message(), testEnv, options);
    const firstRow = await sourceRow(String(ACTIVITY_ID));

    await consumeStravaEvent(message(), testEnv, options);
    const secondRow = await sourceRow(String(ACTIVITY_ID));

    expect(secondRow!.activity_id).toBe(firstRow!.activity_id);
    const count = await env.REGISTRY.prepare(
      "SELECT COUNT(*) AS n FROM activities",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
    const storedDetail = await env.RAW.get(detailKey(ACTIVITY_ID));
    expect(await storedDetail?.text()).toBe(DETAIL_JSON);
  });

  it("overwrites detail.json on update and does not touch streams or photos", async () => {
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response(STREAMS_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () =>
          new Response(PHOTOS_JSON),
      }),
    );
    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });

    const retitled = DETAIL_JSON.replace("Morning Gravel", "Evening Gravel");
    const updateStub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(retitled),
      }),
    );

    await consumeStravaEvent(message({ kind: "update" }), testEnv, {
      client: apiClient(updateStub),
    });

    const storedDetail = await env.RAW.get(detailKey(ACTIVITY_ID));
    expect(await storedDetail?.text()).toBe(retitled);
    expect(updateStub.requests).toHaveLength(1);
  });

  it("sets deleted_at on delete and leaves R2 objects and activities row in place", async () => {
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response(STREAMS_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () => new Response("[]"),
      }),
    );
    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });

    const deleteStub = stubFetch(() => {
      throw new Error("delete should not fetch");
    });
    await consumeStravaEvent(message({ kind: "delete" }), testEnv, {
      client: apiClient(deleteStub),
    });

    expect(deleteStub.requests).toHaveLength(0);
    const row = await sourceRow(String(ACTIVITY_ID));
    expect(row?.deleted_at).not.toBeNull();
    expect(await env.RAW.get(detailKey(ACTIVITY_ID))).not.toBeNull();
    const activity = await env.REGISTRY.prepare(
      "SELECT * FROM activities WHERE activity_id = ?1",
    )
      .bind(row!.activity_id as string)
      .first();
    expect(activity).not.toBeNull();
  });

  it("clears deleted_at when the activity is upserted again", async () => {
    const stub = stubFetch(
      respondByPath({
        [`/api/v3/activities/${ACTIVITY_ID}`]: () => new Response(DETAIL_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/streams`]: () =>
          new Response(STREAMS_JSON),
        [`/api/v3/activities/${ACTIVITY_ID}/photos`]: () => new Response("[]"),
      }),
    );
    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });
    await consumeStravaEvent(message({ kind: "delete" }), testEnv, {
      client: apiClient(stub),
    });
    await consumeStravaEvent(message(), testEnv, { client: apiClient(stub) });

    const row = await sourceRow(String(ACTIVITY_ID));
    expect(row?.deleted_at).toBeNull();
  });

  it("throws RateLimitedError on a 429 from the detail fetch", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));

    await expect(
      consumeStravaEvent(message(), testEnv, { client: apiClient(stub) }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("does not fetch and warns on an athlete event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = stubFetch(() => {
      throw new Error("athlete events should not fetch");
    });

    await consumeStravaEvent(message({ objectType: "athlete" }), testEnv, {
      client: apiClient(stub),
    });

    expect(stub.requests).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
