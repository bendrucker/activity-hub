import {
  Encoder,
  Profile,
  type Encodable,
  type FileIdMesg,
  type RecordMesg,
} from "@garmin/fitsdk";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokens } from "../../test/broker";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { SECRETS } from "../../test/secrets";
import { RateLimitedError, type WahooIngestMessage } from "../ingest";
import { upsertSourceRecord } from "../registry";
import { tokenBroker } from "../tokens/broker";
import { WahooClient } from "./client";
import { consumeWahooEvent } from "./consume";
import type { WahooWorkoutSummary } from "./summary";

const testEnv: Env = { ...env, ...SECRETS };

const WORKOUT_ID = 56519;

// Synthetic route in Los Angeles, so tz-lookup resolves America/Los_Angeles.
const LAT = 34.0522;
const LON = -118.2437;

const FILE_ID = Profile.MesgNum.FILE_ID as number;
const RECORD = Profile.MesgNum.RECORD as number;

function syntheticFit(points: number): Uint8Array {
  const start = new Date("2026-07-01T14:00:00Z");
  const encoder = new Encoder();
  const fileId: Encodable<FileIdMesg> = {
    mesgNum: FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: start,
    serialNumber: 1234,
  };
  encoder.writeMesg(fileId);
  for (let i = 0; i < points; i++) {
    const record: Encodable<RecordMesg> = {
      mesgNum: RECORD,
      timestamp: new Date(start.getTime() + i * 1000),
      positionLat: Math.round((LAT + i * 0.001) * (2 ** 31 / 180)),
      positionLong: Math.round(LON * (2 ** 31 / 180)),
    };
    encoder.writeMesg(record);
  }
  return encoder.close();
}

// A trainer ride: records exist but none carry GPS.
function indoorFit(): Uint8Array {
  const start = new Date("2026-07-01T14:00:00Z");
  const encoder = new Encoder();
  const fileId: Encodable<FileIdMesg> = {
    mesgNum: FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: start,
    serialNumber: 1234,
  };
  encoder.writeMesg(fileId);
  const record: Encodable<RecordMesg> = {
    mesgNum: RECORD,
    timestamp: start,
    heartRate: 120,
  };
  encoder.writeMesg(record);
  return encoder.close();
}

const SUMMARY: WahooWorkoutSummary = {
  id: 8297,
  duration_total_accum: "275.20",
  file: { url: "https://cdn.wahooligan.com/workout_file/file/abc/2026.fit" },
  workout: {
    id: WORKOUT_ID,
    starts: "2026-07-01T14:00:00.000Z",
    minutes: 12,
    workout_type_id: 0,
  },
};

function message(summary: WahooWorkoutSummary = SUMMARY): WahooIngestMessage {
  return {
    source: "wahoo",
    kind: "workout_summary",
    workoutId: summary.workout.id,
    summary,
  };
}

// What backfill enqueues: the list entry, no summary.
function backfillMessage(
  workout: Record<string, unknown> = {},
): WahooIngestMessage {
  return {
    source: "wahoo",
    kind: "workout",
    workoutId: WORKOUT_ID,
    workout: { ...SUMMARY.workout, name: "morning ride", ...workout },
  };
}

const SUMMARY_PATH = `/v1/workouts/${WORKOUT_ID}/workout_summary`;

function summaryResponse(): Response {
  const { workout: _nested, ...summary } = SUMMARY;
  return new Response(JSON.stringify(summary));
}

function apiClient(stub: FetchStub): WahooClient {
  return new WahooClient({
    apiBase: "https://api.example",
    tokens: tokenBroker(env, "wahoo"),
    fetch: stub.fetch,
  });
}

function summaryKey(id: number): string {
  return `raw/wahoo/workouts/${id}/summary.json`;
}

function fitKey(id: number): string {
  return `raw/wahoo/workouts/${id}/original.fit`;
}

async function sourceRow(
  sourceId: string,
): Promise<Record<string, unknown> | null> {
  return env.REGISTRY.prepare(
    "SELECT * FROM activity_sources WHERE source = 'wahoo' AND source_id = ?1",
  )
    .bind(sourceId)
    .first();
}

async function activityRow(
  activityId: string,
): Promise<Record<string, unknown> | null> {
  return env.REGISTRY.prepare("SELECT * FROM activities WHERE activity_id = ?1")
    .bind(activityId)
    .first();
}

beforeEach(async () => {
  await clearTokens("wahoo");
  await tokenBroker(env, "wahoo").store({
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 7200,
  });
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
  const existing = await env.RAW.list({
    prefix: `raw/wahoo/workouts/${WORKOUT_ID}/`,
  });
  await Promise.all(
    existing.objects.map((object) => env.RAW.delete(object.key)),
  );
});

describe("consumeWahooEvent", () => {
  it("downloads the FIT, archives it with the summary, and mints a registry activity", async () => {
    const fit = syntheticFit(5);
    const stub = stubFetch(() => new Response(fit));

    await consumeWahooEvent(message(), testEnv, { fetch: stub.fetch });

    expect(stub.requests[0]!.url).toBe(SUMMARY.file!.url);

    const storedSummary = await env.RAW.get(summaryKey(WORKOUT_ID));
    expect(await storedSummary?.json()).toEqual(SUMMARY);
    const storedFit = await env.RAW.get(fitKey(WORKOUT_ID));
    expect(new Uint8Array((await storedFit?.arrayBuffer())!)).toEqual(fit);

    const row = await sourceRow(String(WORKOUT_ID));
    expect(row).toMatchObject({
      raw_keys: JSON.stringify({
        summary: summaryKey(WORKOUT_ID),
        original: fitKey(WORKOUT_ID),
      }),
    });

    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({
      sport: "ride",
      timezone: "America/Los_Angeles",
      timezone_inferred: 0,
      started_at: "2026-07-01T14:00:00.000Z",
      duration_s: 275,
    });
  });

  it("is a no-op on a duplicate delivery", async () => {
    const stub = stubFetch(() => new Response(syntheticFit(5)));
    const options = { fetch: stub.fetch };

    await consumeWahooEvent(message(), testEnv, options);
    const firstRow = await sourceRow(String(WORKOUT_ID));

    await consumeWahooEvent(message(), testEnv, options);
    const secondRow = await sourceRow(String(WORKOUT_ID));

    expect(secondRow!.activity_id).toBe(firstRow!.activity_id);
    const count = await env.REGISTRY.prepare(
      "SELECT COUNT(*) AS n FROM activities",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("attaches to the matching Strava activity and overwrites its telemetry", async () => {
    const strava = await upsertSourceRecord(env.REGISTRY, {
      source: "strava",
      sourceId: "42",
      startedAt: "2026-07-01T14:00:30.000Z",
      timezone: "America/Chicago",
      timezoneInferred: false,
      sport: "ride",
      durationS: 280,
      rawKeys: {},
    });
    const stub = stubFetch(() => new Response(syntheticFit(5)));

    await consumeWahooEvent(message(), testEnv, { fetch: stub.fetch });

    const row = await sourceRow(String(WORKOUT_ID));
    expect(row!.activity_id).toBe(strava.activityId);

    const activity = await activityRow(strava.activityId);
    expect(activity).toMatchObject({
      started_at: "2026-07-01T14:00:00.000Z",
      duration_s: 275,
      timezone: "America/Los_Angeles",
      timezone_inferred: 0,
    });
  });

  it("borrows the nearest activity's timezone when the FIT has no GPS", async () => {
    await upsertSourceRecord(env.REGISTRY, {
      source: "strava",
      sourceId: "41",
      startedAt: "2026-06-25T13:00:00.000Z",
      timezone: "America/Denver",
      timezoneInferred: false,
      sport: "run",
      durationS: 1800,
      rawKeys: {},
    });
    const stub = stubFetch(() => new Response(indoorFit()));

    await consumeWahooEvent(message(), testEnv, { fetch: stub.fetch });

    const row = await sourceRow(String(WORKOUT_ID));
    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({
      timezone: "America/Denver",
      timezone_inferred: 1,
    });
  });

  it("falls back to UTC when the FIT has no GPS and the registry is empty", async () => {
    const stub = stubFetch(() => new Response(indoorFit()));

    await consumeWahooEvent(message(), testEnv, { fetch: stub.fetch });

    const row = await sourceRow(String(WORKOUT_ID));
    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({ timezone: "UTC", timezone_inferred: 1 });
  });

  it("archives an undecodable FIT and warns instead of failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = stubFetch(
      () => new Response(new TextEncoder().encode("not a fit file")),
    );

    await consumeWahooEvent(message(), testEnv, { fetch: stub.fetch });

    expect(await env.RAW.get(fitKey(WORKOUT_ID))).not.toBeNull();
    expect(await sourceRow(String(WORKOUT_ID))).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws on a failed download without writing anything", async () => {
    const stub = stubFetch(() => new Response("gone", { status: 500 }));

    await expect(
      consumeWahooEvent(message(), testEnv, { fetch: stub.fetch }),
    ).rejects.toThrow(/500/);

    expect(await env.RAW.get(fitKey(WORKOUT_ID))).toBeNull();
    expect(await env.RAW.get(summaryKey(WORKOUT_ID))).toBeNull();
    expect(await sourceRow(String(WORKOUT_ID))).toBeNull();
  });

  it("fetches the summary for a backfill message and ingests it", async () => {
    const api = stubFetch(() => summaryResponse());
    const download = stubFetch(() => new Response(syntheticFit(5)));

    await consumeWahooEvent(backfillMessage(), testEnv, {
      fetch: download.fetch,
      client: apiClient(api),
    });

    expect(new URL(api.requests[0]!.url).pathname).toBe(SUMMARY_PATH);
    expect(download.requests[0]!.url).toBe(SUMMARY.file!.url);

    const storedSummary = await env.RAW.get(summaryKey(WORKOUT_ID));
    expect(await storedSummary?.json()).toEqual({
      ...SUMMARY,
      workout: { ...SUMMARY.workout, name: "morning ride" },
    });

    const row = await sourceRow(String(WORKOUT_ID));
    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({
      sport: "ride",
      started_at: "2026-07-01T14:00:00.000Z",
      duration_s: 275,
    });
  });

  it("skips a backfill workout whose summary 404s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = stubFetch(() => new Response("not found", { status: 404 }));

    const outcome = await consumeWahooEvent(backfillMessage(), testEnv, {
      client: apiClient(api),
    });

    expect(outcome).toBe("skipped: unexplained missing summary");
    expect(await sourceRow(String(WORKOUT_ID))).toBeNull();
    expect(await env.RAW.get(summaryKey(WORKOUT_ID))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Third-party apps sync their own activities into Wahoo, which stores a
  // stub with a null summary. The real recording is the foreign one, so the
  // skip is correct and the outcome says where the copy lives.
  it("names the app and id a sync stub's real copy lives under", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = stubFetch(() => new Response("unauthorized", { status: 401 }));

    const outcome = await consumeWahooEvent(
      backfillMessage({ workout_token: "FID1085 19536737704:0" }),
      testEnv,
      { client: apiClient(api) },
    );

    expect(outcome).toBe("skipped: third-party sync stub, strava 19536737704");
    expect(await sourceRow(String(WORKOUT_ID))).toBeNull();
    warn.mockRestore();
  });

  // Wahoo answers for a workout that never recorded with a 401 as often as a
  // 404. The client retries once on a refreshed token, so a second 401 is the
  // workout's, not the token's.
  it("skips a backfill workout whose summary 401s on a live token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = stubFetch(() => new Response("unauthorized", { status: 401 }));

    await consumeWahooEvent(backfillMessage(), testEnv, {
      client: apiClient(api),
    });

    expect(
      api.requests.map((request) => new URL(request.url).pathname),
    ).toEqual([SUMMARY_PATH]);
    expect(await sourceRow(String(WORKOUT_ID))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // A summary this code cannot read is a defect on this side. Labelling it
  // like a missing one writes the workout off as an absence at Wahoo.
  it("skips a backfill workout whose summary does not parse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = stubFetch(() => new Response(JSON.stringify({ id: 8297 })));

    const outcome = await consumeWahooEvent(
      backfillMessage({ minutes: undefined }),
      testEnv,
      { client: apiClient(api) },
    );

    expect(outcome).toBe("skipped: summary returned but unreadable");
    expect(await sourceRow(String(WORKOUT_ID))).toBeNull();
    warn.mockRestore();
  });

  it("throws RateLimitedError when the summary fetch is rate limited", async () => {
    const api = stubFetch(() => new Response("slow down", { status: 429 }));

    await expect(
      consumeWahooEvent(backfillMessage(), testEnv, { client: apiClient(api) }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("ingests a backfill workout whose summary carries no file", async () => {
    const api = stubFetch(
      () =>
        new Response(
          JSON.stringify({ id: 8297, duration_total_accum: "6998.0" }),
        ),
    );

    const outcome = await consumeWahooEvent(backfillMessage(), testEnv, {
      client: apiClient(api),
    });

    expect(outcome).toBe("ok: summary only, no file");
    const storedSummary = await env.RAW.get(summaryKey(WORKOUT_ID));
    expect(storedSummary).not.toBeNull();
    expect(await env.RAW.get(fitKey(WORKOUT_ID))).toBeNull();

    const row = await sourceRow(String(WORKOUT_ID));
    expect(row).toMatchObject({
      raw_keys: JSON.stringify({ summary: summaryKey(WORKOUT_ID) }),
    });
    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({
      sport: "ride",
      timezone_inferred: 1,
      duration_s: 6998,
    });
  });

  it("ingests a webhook summary whose file is null", async () => {
    const stub = stubFetch(() => {
      throw new Error("no fetches expected without a file URL");
    });
    const summary: WahooWorkoutSummary = { ...SUMMARY, file: null };

    await consumeWahooEvent(message(summary), testEnv, {
      fetch: stub.fetch,
    });

    const row = await sourceRow(String(WORKOUT_ID));
    expect(row).toMatchObject({
      raw_keys: JSON.stringify({ summary: summaryKey(WORKOUT_ID) }),
    });
  });
});
