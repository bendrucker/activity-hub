import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import polyline from "@mapbox/polyline";
import { writeActivityParquet } from "./parquet";
import { publishActivity } from "./publish";
import type { TelemetryActivity, TelemetryRecord, TelemetrySession } from "../src/import/telemetry";

let instance: DuckDBInstance;
let work: string;

beforeEach(async () => {
  instance = await DuckDBInstance.create(":memory:");
  work = await mkdtemp(join(tmpdir(), "publish-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const RIDE_START = new Date("2026-01-01T14:00:00.000Z");

function record(second: number, overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    timestamp: new Date(RIDE_START.getTime() + second * 1000),
    position_lat: 37.7 + second / 10000,
    position_lon: -122.4,
    altitude: 10 + second,
    distance: second * 5,
    speed: 5,
    power: 200,
    cadence: 80,
    heart_rate: 140,
    temperature: 18,
    grade: null,
    left_right_balance: null,
    accumulated_power: null,
    gps_accuracy: null,
    segment: 0,
    developer_fields: null,
    ...overrides,
  };
}

function ride(seconds: number, overrides: Partial<TelemetryRecord> = {}) {
  return Array.from({ length: seconds }, (_, second) => record(second, overrides));
}

function session(overrides: Partial<TelemetrySession> = {}): TelemetrySession {
  return {
    message_index: 0,
    timestamp: RIDE_START,
    start_time: RIDE_START,
    start_position_lat: null,
    start_position_lon: null,
    end_position_lat: null,
    end_position_lon: null,
    sport: "cycling",
    sub_sport: null,
    total_elapsed_time: 600,
    total_timer_time: 600,
    total_moving_time: 540,
    total_distance: 3000,
    total_calories: null,
    total_work: null,
    total_ascent: 120,
    total_descent: 100,
    avg_speed: null,
    max_speed: null,
    avg_heart_rate: null,
    max_heart_rate: null,
    min_heart_rate: null,
    avg_cadence: null,
    max_cadence: null,
    avg_power: null,
    max_power: null,
    normalized_power: null,
    threshold_power: null,
    training_stress_score: null,
    intensity_factor: null,
    total_training_effect: null,
    avg_altitude: null,
    min_altitude: null,
    max_altitude: null,
    avg_grade: null,
    avg_temperature: null,
    max_temperature: null,
    num_laps: null,
    first_lap_index: null,
    trigger: null,
    developer_fields: null,
    ...overrides,
  };
}

async function seed(
  activityId: string,
  overrides: Partial<TelemetryActivity> = {},
  rawKey = "raw/wahoo/a.fit",
): Promise<string> {
  const directory = join(work, activityId);
  await mkdir(directory, { recursive: true });
  await writeActivityParquet(instance, directory, activityId, rawKey, {
    source: "fit",
    records: ride(600),
    laps: [],
    sessions: [session()],
    device: null,
    developerFields: [],
    errors: [],
    ...overrides,
  });
  return directory;
}

async function publish(activityId: string, decode: string) {
  return publishActivity({ work: { activityId, decode } }, { instance });
}

test("summarizes a ride into the row the site shows", async () => {
  const decode = await seed("a");

  const { outcome } = await publish("a", decode);

  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.artifact).toMatchObject({
    averageWatts: 200,
    powerSource: "measured",
    distanceM: 3000,
    elevationM: 120,
    movingS: 540,
  });
  expect(outcome.artifact.elevationProfile).toHaveLength(100);
  expect(outcome.artifact.bests.at(0)).toEqual({ durationS: 5, watts: 200 });
});

// One point in ten, so a five-hour ride is a map rather than a stream. The
// decoded polyline is the check: an off-by-one in the stride shows up as a
// count, and a swapped pair shows up as a coordinate.
test("decimates the track to every tenth point", async () => {
  const decode = await seed("a");

  const { outcome } = await publish("a", decode);

  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok" || outcome.artifact.polyline === null) return;
  const points = polyline.decode(outcome.artifact.polyline);
  expect(points).toHaveLength(60);
  expect(points[0]?.[0]).toBeCloseTo(37.7, 4);
  expect(points[0]?.[1]).toBeCloseTo(-122.4, 4);
  expect(points[1]?.[0]).toBeCloseTo(37.701, 4);
});

// Sampled by distance, so the profile draws the shape of the road. A ride that
// climbs steadily with distance comes back monotonic whatever the pacing was.
test("spaces the elevation profile by distance", async () => {
  const decode = await seed("a");

  const { outcome } = await publish("a", decode);

  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  const profile = outcome.artifact.elevationProfile ?? [];
  expect(profile).toHaveLength(100);
  expect(profile.at(0)).toBeLessThan(profile.at(-1) ?? 0);
  expect(profile.toSorted((a, b) => a - b)).toEqual(profile);
});

test("tags a GPX ride's power as estimated", async () => {
  const decode = await seed("a", { source: "gpx" });

  const { outcome } = await publish("a", decode);

  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.artifact.powerSource).toBe("estimated");
});

test("reports no power source and no bests for a ride without power", async () => {
  const decode = await seed("a", { records: ride(600, { power: null }) });

  const { outcome } = await publish("a", decode);

  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.artifact).toMatchObject({
    averageWatts: null,
    powerSource: "none",
    bests: [],
  });
});

// A file whose device wrote records but no session summary still has a track
// and a power curve. Leaving the totals null lets the Worker fall back to the
// provider's numbers rather than publishing zeroes.
test("leaves the totals null when the device wrote no session", async () => {
  const decode = await seed("a", { sessions: [] });

  const { outcome } = await publish("a", decode);

  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.artifact).toMatchObject({
    distanceM: null,
    elevationM: null,
    movingS: null,
  });
  expect(outcome.artifact.polyline).not.toBeNull();
});

// The missing artifact is the failure the Worker parks against, so it has to
// arrive as this activity's outcome rather than as a non-2xx that would retry
// the whole message.
test("answers with a failed outcome when the artifact is missing", async () => {
  const { outcome } = await publish("a", join(work, "absent"));

  expect(outcome.status).toBe("failed");
  if (outcome.status !== "failed") return;
  expect(outcome.error).toContain("records.parquet");
});
