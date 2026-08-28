// Reduces one activity's decode Parquet to the handful of values the website
// shows. Everything here is a lossy summary of the records table, computed in
// the container because a Worker cannot read Parquet and the site should not
// hold 25 million rows to draw a sparkline.

import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import polyline from "@mapbox/polyline";
import type {
  PowerBest,
  PowerSource,
  PublishArtifact,
  PublishRequest,
  PublishResponse,
} from "../src/transform/protocol";
import { powerBestsSql } from "./power";
import { literal } from "./sql";

export interface PublishDeps {
  instance: DuckDBInstance;
  configure?: (connection: DuckDBConnection) => Promise<void>;
}

// A 1 Hz ride encodes to roughly one byte per point after polyline's delta
// coding, so a five-hour ride is 18 kB of map that renders at a few hundred
// pixels. Every tenth point holds the shape at a tenth the size.
const TRACK_STRIDE = 10;

// Sampled by distance rather than by time, so a climb occupies the width it
// covers on the map instead of the width it took to ride.
const PROFILE_SAMPLES = 100;

export async function publishActivity(
  request: PublishRequest,
  deps: PublishDeps,
): Promise<PublishResponse> {
  const { activityId, decode } = request.work;
  const connection = await deps.instance.connect();
  try {
    await deps.configure?.(connection);
    const prefix = decode.endsWith("/") ? decode.slice(0, -1) : decode;
    return {
      outcome: {
        activityId,
        status: "ok",
        artifact: await artifact(connection, prefix),
      },
    };
  } catch (error) {
    return {
      outcome: {
        activityId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    connection.disconnectSync();
  }
}

async function artifact(connection: DuckDBConnection, prefix: string): Promise<PublishArtifact> {
  const records = `read_parquet(${literal(`${prefix}/records.parquet`)})`;
  const meta = `read_parquet(${literal(`${prefix}/meta.parquet`)})`;
  const sessions = `read_parquet(${literal(`${prefix}/sessions.parquet`)})`;

  const power = await powerSummary(connection, records, meta);
  return {
    polyline: await track(connection, records),
    elevationProfile: await elevationProfile(connection, records),
    averageWatts: power.averageWatts,
    powerSource: power.source,
    bests: power.source === "none" ? [] : await bests(connection, records),
    ...(await totals(connection, sessions)),
  };
}

interface DeviceTotals {
  distanceM: number | null;
  elevationM: number | null;
  movingS: number | null;
}

// Summed across sessions, because a multisport file records one per leg and
// the feed shows the whole outing. Moving time falls back to timer time: not
// every device records the pause-aware total, and both mean the clock the
// device was counting.
async function totals(connection: DuckDBConnection, sessions: string): Promise<DeviceTotals> {
  const reader = await connection.runAndReadAll(`
    SELECT
      SUM(total_distance) AS distance_m,
      SUM(total_ascent) AS elevation_m,
      SUM(COALESCE(total_moving_time, total_timer_time)) AS moving_s
    FROM ${sessions}`);

  const [row] = reader.getRowObjects();
  return {
    distanceM: optional(row?.distance_m),
    elevationM: optional(row?.elevation_m),
    movingS: optional(row?.moving_s),
  };
}

function optional(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

async function track(connection: DuckDBConnection, records: string): Promise<string | null> {
  const reader = await connection.runAndReadAll(`
    SELECT lat, lon
    FROM (
      SELECT
        position_lat AS lat,
        position_lon AS lon,
        row_number() OVER (ORDER BY timestamp) - 1 AS n
      FROM ${records}
      WHERE position_lat IS NOT NULL AND position_lon IS NOT NULL
    )
    WHERE n % ${TRACK_STRIDE} = 0
    ORDER BY n`);

  const points: [number, number][] = reader
    .getRowObjects()
    .map((row) => [Number(row.lat), Number(row.lon)]);
  return points.length > 0 ? polyline.encode(points) : null;
}

// Buckets are widths of the ride's distance span, so an activity that stopped
// recording distance mid-ride still spreads across the profile rather than
// piling into one bucket. LEAST keeps the farthest point out of bucket 100.
async function elevationProfile(
  connection: DuckDBConnection,
  records: string,
): Promise<number[] | null> {
  const reader = await connection.runAndReadAll(`
    WITH points AS (
      SELECT altitude, distance
      FROM ${records}
      WHERE altitude IS NOT NULL AND distance IS NOT NULL
    ),
    span AS (SELECT MIN(distance) AS d0, MAX(distance) AS d1 FROM points)
    SELECT bucket, AVG(altitude) AS altitude
    FROM (
      SELECT
        LEAST(
          ${PROFILE_SAMPLES - 1},
          CAST(FLOOR(${PROFILE_SAMPLES} * (distance - d0) / NULLIF(d1 - d0, 0)) AS BIGINT)
        ) AS bucket,
        altitude
      FROM points, span
    )
    WHERE bucket IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket`);

  const sampled = new Map<number, number>();
  for (const row of reader.getRowObjects()) {
    sampled.set(Number(row.bucket), Math.round(Number(row.altitude)));
  }
  return sampled.size > 0 ? fill(sampled) : null;
}

// A ride that sat still for a stretch leaves its buckets empty, and a hole in
// the array would draw as a gap in the profile. Carrying the neighbouring
// altitude across draws it as the flat the rider actually spent there.
function fill(sampled: Map<number, number>): number[] {
  const profile: number[] = [];
  let carried = sampled.get(Math.min(...sampled.keys())) ?? 0;
  for (let bucket = 0; bucket < PROFILE_SAMPLES; bucket += 1) {
    carried = sampled.get(bucket) ?? carried;
    profile.push(carried);
  }
  return profile;
}

interface PowerSummary {
  averageWatts: number | null;
  source: PowerSource;
}

// GPX carries no power field, so any wattage on a GPX activity was estimated
// by whatever produced the file. PROVENANCE in container/tables.ts draws the
// same line from the same column.
async function powerSummary(
  connection: DuckDBConnection,
  records: string,
  meta: string,
): Promise<PowerSummary> {
  const reader = await connection.runAndReadAll(`
    SELECT
      (SELECT AVG(power) FROM ${records}) AS average_watts,
      (SELECT COUNT(power) FROM ${records}) AS samples,
      (SELECT ANY_VALUE(source) FROM ${meta} WHERE kind = 'device') AS format`);

  const [row] = reader.getRowObjects();
  if (row === undefined || Number(row.samples) === 0) {
    return { averageWatts: null, source: "none" };
  }
  return {
    averageWatts: Math.round(Number(row.average_watts)),
    source: row.format === "gpx" ? "estimated" : "measured",
  };
}

async function bests(connection: DuckDBConnection, records: string): Promise<PowerBest[]> {
  const reader = await connection.runAndReadAll(`
    SELECT duration_s, watts
    FROM (${powerBestsSql(`SELECT * FROM ${records}`)})
    ORDER BY duration_s`);

  return reader.getRowObjects().map((row) => ({
    durationS: Number(row.duration_s),
    watts: Math.round(Number(row.watts)),
  }));
}
