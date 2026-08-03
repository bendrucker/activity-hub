import {
  Encoder,
  Profile,
  type Encodable,
  type FileIdMesg,
  type RecordMesg,
} from "@garmin/fitsdk";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import { SECRETS } from "../../test/secrets";
import type { WahooIngestMessage } from "../ingest";
import { upsertSourceRecord } from "../registry";
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

    await consumeWahooEvent(message(), testEnv, { fetchImpl: stub.fetchImpl });

    expect(stub.requests[0]!.url).toBe(SUMMARY.file.url);

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
    const options = { fetchImpl: stub.fetchImpl };

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

    await consumeWahooEvent(message(), testEnv, { fetchImpl: stub.fetchImpl });

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

    await consumeWahooEvent(message(), testEnv, { fetchImpl: stub.fetchImpl });

    const row = await sourceRow(String(WORKOUT_ID));
    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({
      timezone: "America/Denver",
      timezone_inferred: 1,
    });
  });

  it("falls back to UTC when the FIT has no GPS and the registry is empty", async () => {
    const stub = stubFetch(() => new Response(indoorFit()));

    await consumeWahooEvent(message(), testEnv, { fetchImpl: stub.fetchImpl });

    const row = await sourceRow(String(WORKOUT_ID));
    const activity = await activityRow(row!.activity_id as string);
    expect(activity).toMatchObject({ timezone: "UTC", timezone_inferred: 1 });
  });

  it("archives an undecodable FIT and warns instead of failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = stubFetch(
      () => new Response(new TextEncoder().encode("not a fit file")),
    );

    await consumeWahooEvent(message(), testEnv, { fetchImpl: stub.fetchImpl });

    expect(await env.RAW.get(fitKey(WORKOUT_ID))).not.toBeNull();
    expect(await sourceRow(String(WORKOUT_ID))).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws on a failed download without writing anything", async () => {
    const stub = stubFetch(() => new Response("gone", { status: 500 }));

    await expect(
      consumeWahooEvent(message(), testEnv, { fetchImpl: stub.fetchImpl }),
    ).rejects.toThrow(/500/);

    expect(await env.RAW.get(fitKey(WORKOUT_ID))).toBeNull();
    expect(await env.RAW.get(summaryKey(WORKOUT_ID))).toBeNull();
    expect(await sourceRow(String(WORKOUT_ID))).toBeNull();
  });
});
