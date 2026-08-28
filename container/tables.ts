// The lake tables, each a query over the decode artifacts plus the registry
// snapshot. Sources are URIs rather than fixed keys so the same SQL runs
// against S3 in the container and against a directory of Parquet files in a
// test, which is the only way this transformation is checkable without R2.

import {
  emptySelectSql,
  LAPS as LAPS_SCHEMA,
  META as META_SCHEMA,
  RECORDS as RECORDS_SCHEMA,
  SESSIONS as SESSIONS_SCHEMA,
  type Table,
} from "./schema";
import { powerBestsSql } from "./power";
import { literal, quote } from "./sql";

export interface LakeSources {
  // Prefix holding one directory per activity, each with the four decode
  // Parquet files. Globbed, never listed.
  decode: string;
  // Newline-delimited JSON the Worker exports from D1, one object per activity.
  registry: string;
  // The Strava bulk export's activities.csv, or null when no export is
  // archived. Strava's own numbers come from here and nowhere else.
  stravaExport: string | null;
  // A glob matching no files is an error in DuckDB rather than an empty scan,
  // and the first build runs before any decode has landed.
  decoded: boolean;
}

export interface LakeTable {
  name: string;
  sql(sources: LakeSources): string;
  // A DuckDB PARTITION_BY expression list. Only the tables large enough that a
  // reader would otherwise scan the whole corpus to answer one year's question
  // carry one, because each partition costs a file.
  partitionBy?: string;
}

function decodeGlob(sources: LakeSources, table: string): string {
  return literal(`${sources.decode}/*/${table}.parquet`);
}

// Passthrough tables. The decode stage already wrote them at the right grain
// with activity_id prefixed, so the lake build only unions them.
function passthrough(name: string, table: Table<object>): LakeTable {
  return {
    name,
    sql: (sources) => scan(sources, name, table),
  };
}

// union_by_name because developer_fields makes the JSON column's contents vary
// per activity, and a future column added to the decode schema should widen
// the lake rather than break the scan of everything written before it.
function scan(sources: LakeSources, name: string, table: Table<object>): string {
  return sources.decoded
    ? `SELECT * FROM read_parquet(${decodeGlob(sources, name)}, union_by_name = true)`
    : emptySelectSql(table);
}

// 24 million rows across thirteen years. Year is the only partition key worth
// its file count: nearly every question about records is scoped to a season,
// and a finer key would shard a single ride across partitions. It is projected
// as a column because PARTITION_BY names columns, and a record whose timestamp
// failed to decode lands in DuckDB's default partition rather than dropping.
export const RECORDS: LakeTable = {
  name: "records",
  partitionBy: "year",
  sql: (sources) =>
    `SELECT *, year(timestamp) AS year FROM (${scan(sources, "records", RECORDS_SCHEMA)})`,
};

export const LAPS = passthrough("laps", LAPS_SCHEMA);
export const SESSIONS = passthrough("sessions", SESSIONS_SCHEMA);

// One row per activity per developer field or device, kept as its own table so
// a query can ask which activities carried Wahoo wind speed without opening
// 4,000 record files.
export const TELEMETRY_META = passthrough("meta", META_SCHEMA);

// A session's average weighted by its own timer time. Ignoring the weight
// would let a 30-second transition session pull an hour-long ride's average
// as hard as the ride itself. NULLIF keeps a file whose sessions all report
// zero timer time from dividing by zero.
function weighted(column: string): string {
  return `SUM(${column} * total_timer_time) / NULLIF(SUM(CASE WHEN ${column} IS NULL THEN 0 ELSE total_timer_time END), 0)`;
}

// An activity's session rows are per-sport segments of one ride. Summing the
// totals and re-averaging the averages weighted by timer time is what makes a
// multi-sport file comparable to a single-session one.
const DEVICE_TOTALS = `
  device AS (
    SELECT
      activity_id,
      SUM(total_distance)                    AS device_distance_m,
      SUM(total_ascent)                      AS device_elevation_gain_m,
      SUM(total_descent)                     AS device_elevation_loss_m,
      SUM(total_elapsed_time)                AS device_elapsed_time_s,
      SUM(total_timer_time)                  AS device_timer_time_s,
      SUM(total_moving_time)                 AS device_moving_time_s,
      SUM(total_calories)                    AS device_calories,
      SUM(total_work)                        AS device_total_work_j,
      MAX(max_speed)                         AS device_max_speed_mps,
      MAX(max_power)                         AS device_max_power_w,
      MAX(max_heart_rate)                    AS device_max_heart_rate_bpm,
      MAX(max_cadence)                       AS device_max_cadence_rpm,
      MAX(max_altitude)                      AS device_max_altitude_m,
      MIN(min_altitude)                      AS device_min_altitude_m,
      ${weighted("avg_speed")}               AS device_avg_speed_mps,
      ${weighted("avg_power")}               AS device_avg_power_w,
      ${weighted("normalized_power")}        AS device_normalized_power_w,
      ${weighted("avg_heart_rate")}          AS device_avg_heart_rate_bpm,
      ${weighted("avg_cadence")}             AS device_avg_cadence_rpm,
      ${weighted("avg_temperature")}         AS device_avg_temperature_c,
      COUNT(*)                               AS device_session_count,
      ANY_VALUE(sport)                       AS device_sport,
      ANY_VALUE(sub_sport)                   AS device_sub_sport
    FROM sessions
    GROUP BY activity_id
  )`;

// Provenance for the telemetry: which file won, and whether its power is real.
// `meta` carries exactly one device row per activity, so the filter makes this
// one row per activity without a GROUP BY.
const PROVENANCE = `
  provenance AS (
    SELECT
      activity_id,
      source   AS telemetry_format,
      raw_key  AS telemetry_raw_key,
      CASE
        WHEN raw_key LIKE 'raw/wahoo/%'         THEN 'wahoo'
        WHEN raw_key LIKE 'raw/strava/export/%' THEN 'strava_export'
        WHEN raw_key LIKE 'raw/strava/%'        THEN 'strava'
        ELSE 'unknown'
      END      AS telemetry_origin
    FROM meta
    WHERE kind = 'device'
  ),
  power AS (
    SELECT activity_id, COUNT(power) AS power_samples
    FROM records
    GROUP BY activity_id
  )`;

interface StravaColumn {
  name: string;
  type: "VARCHAR" | "DOUBLE";
  // Reads the column out of the read_csv relation, under the export's own
  // header name.
  expression: string;
}

// Strava's export CSV repeats several header names, and DuckDB disambiguates
// the repeats with a numeric suffix. The duplicated pairs are not redundant:
// the first "Distance" is the display value in kilometres and the second is
// metres, so every reference here is to the suffixed second column.
//
// Every numeric column is cast rather than left to inference. DuckDB types a
// CSV column from the values it samples, so a column that happens to hold
// whole numbers in one export and fractions in the next would change the
// lake's schema between two runs.
//
// One list drives both the read and the empty relation that stands in for it,
// because a column added to one and not the other changes the activities
// table's shape depending on whether an export happens to be archived.
const STRAVA_COLUMNS: readonly StravaColumn[] = [
  {
    name: "activity_id",
    type: "VARCHAR",
    expression: csvVarchar("Activity ID"),
  },
  { name: "name", type: "VARCHAR", expression: quote("Activity Name") },
  {
    name: "description",
    type: "VARCHAR",
    expression: quote("Activity Description"),
  },
  { name: "strava_type", type: "VARCHAR", expression: quote("Activity Type") },
  { name: "gear", type: "VARCHAR", expression: quote("Activity Gear") },
  {
    name: "strava_distance_m",
    type: "DOUBLE",
    expression: csvDouble("Distance_1"),
  },
  {
    name: "strava_elevation_gain_m",
    type: "DOUBLE",
    expression: csvDouble("Elevation Gain"),
  },
  {
    name: "strava_elevation_loss_m",
    type: "DOUBLE",
    expression: csvDouble("Elevation Loss"),
  },
  {
    name: "strava_moving_time_s",
    type: "DOUBLE",
    expression: csvDouble("Moving Time"),
  },
  {
    name: "strava_elapsed_time_s",
    type: "DOUBLE",
    expression: csvDouble("Elapsed Time_1"),
  },
  {
    name: "strava_avg_speed_mps",
    type: "DOUBLE",
    expression: csvDouble("Average Speed"),
  },
  {
    name: "strava_max_speed_mps",
    type: "DOUBLE",
    expression: csvDouble("Max Speed"),
  },
  {
    name: "strava_avg_power_w",
    type: "DOUBLE",
    expression: csvDouble("Average Watts"),
  },
  {
    name: "strava_max_power_w",
    type: "DOUBLE",
    expression: csvDouble("Max Watts"),
  },
  {
    name: "strava_weighted_avg_power_w",
    type: "DOUBLE",
    expression: csvDouble("Weighted Average Power"),
  },
  {
    name: "strava_power_count",
    type: "DOUBLE",
    expression: csvDouble("Power Count"),
  },
  {
    name: "strava_avg_heart_rate_bpm",
    type: "DOUBLE",
    expression: csvDouble("Average Heart Rate"),
  },
  {
    name: "strava_max_heart_rate_bpm",
    type: "DOUBLE",
    expression: csvDouble("Max Heart Rate_1"),
  },
  {
    name: "strava_avg_cadence_rpm",
    type: "DOUBLE",
    expression: csvDouble("Average Cadence"),
  },
  {
    name: "strava_calories",
    type: "DOUBLE",
    expression: csvDouble("Calories"),
  },
  {
    name: "strava_total_work_j",
    type: "DOUBLE",
    expression: csvDouble("Total Work"),
  },
  {
    name: "strava_relative_effort",
    type: "DOUBLE",
    expression: csvDouble("Relative Effort_1"),
  },
  {
    name: "strava_grade_adjusted_distance_m",
    type: "DOUBLE",
    expression: csvDouble("Grade Adjusted Distance"),
  },
  { name: "commute", type: "VARCHAR", expression: csvVarchar("Commute_1") },
];

function stravaPresent(source: string): string {
  const columns = STRAVA_COLUMNS.map((column) => `${column.expression} AS ${column.name}`);
  return `
  strava AS (
    SELECT ${columns.join(", ")}
    -- Activity descriptions carry newlines inside quotes and trailing columns
    -- go missing on older rows, so the reader needs null_padding, and DuckDB
    -- refuses to combine that with its parallel scanner.
    FROM read_csv(${literal(source)}, header = true, null_padding = true, parallel = false)
  )`;
}

// With no export archived the join still has to resolve, so an empty relation
// stands in with the same column names and types.
const STRAVA_ABSENT = `
  strava AS (
    SELECT * FROM (
      SELECT ${STRAVA_COLUMNS.map((column) => `NULL::${column.type} AS ${column.name}`).join(", ")}
    ) WHERE false
  )`;

// The registry is the spine: an activity with no telemetry still gets a row,
// because the feed shows it and a missing row would read as a lost ride.
export const ACTIVITIES: LakeTable = {
  name: "activities",
  sql: (sources) => `
    WITH registry AS (
      SELECT
        CAST(activity_id AS VARCHAR) AS activity_id,
        CAST(started_at AS TIMESTAMP) AS started_at,
        CAST(timezone AS VARCHAR) AS timezone,
        CAST(sport AS VARCHAR) AS sport,
        CAST(duration_s AS DOUBLE) AS registry_duration_s,
        CAST(strava_id AS VARCHAR) AS strava_id,
        CAST(wahoo_id AS VARCHAR) AS wahoo_id,
        CAST(deleted_at AS TIMESTAMP) AS deleted_at
      FROM read_json(${literal(sources.registry)}, format = 'newline_delimited')
    ),
    sessions AS (${SESSIONS.sql(sources)}),
    records AS (${RECORDS.sql(sources)}),
    meta AS (${TELEMETRY_META.sql(sources)}),
    ${strava(sources)},
    ${DEVICE_TOTALS},
    ${PROVENANCE}
    SELECT
      registry.activity_id,
      registry.started_at,
      registry.timezone,
      registry.sport,
      registry.registry_duration_s AS duration_s,
      registry.deleted_at,
      strava.name,
      strava.description,
      strava.gear,
      strava.commute,
      provenance.telemetry_origin,
      provenance.telemetry_format,
      provenance.telemetry_raw_key,
      -- GPX power exists only because Strava estimated it, and no FIT power is
      -- ever an estimate, so the format decides this on its own.
      CASE
        WHEN COALESCE(power.power_samples, 0) = 0 THEN 'none'
        WHEN provenance.telemetry_format = 'gpx'  THEN 'estimated'
        ELSE 'measured'
      END AS power_source,
      device.* EXCLUDE (activity_id),
      strava.* EXCLUDE (activity_id, name, description, gear, commute)
    FROM registry
    LEFT JOIN device     ON device.activity_id     = registry.activity_id
    LEFT JOIN provenance ON provenance.activity_id = registry.activity_id
    LEFT JOIN power      ON power.activity_id      = registry.activity_id
    LEFT JOIN strava     ON strava.activity_id     = registry.strava_id
    ORDER BY registry.started_at, registry.activity_id`,
};

// Nineteen rows per powered activity, about 81 thousand across the corpus. Too
// few to earn a partition key: every partition costs a file, and a reader
// asking for one duration across all years would pay for the split without
// ever skipping a file.
//
// Estimated power is tagged rather than dropped, so a query comparing seasons
// can exclude it with a WHERE clause and a query asking what the rider did on
// a GPX-only ride still has an answer.
export const POWER_CURVE: LakeTable = {
  name: "power_curve",
  sql: (sources) => `
    SELECT
      bests.activity_id,
      bests.duration_s,
      bests.watts,
      CASE WHEN format.telemetry_format = 'gpx' THEN 'estimated' ELSE 'measured' END AS power_source
    FROM (${powerBestsSql(scan(sources, "records", RECORDS_SCHEMA))}) AS bests
    LEFT JOIN (
      SELECT activity_id, source AS telemetry_format
      FROM (${scan(sources, "meta", META_SCHEMA)})
      WHERE kind = 'device'
    ) AS format ON format.activity_id = bests.activity_id
    ORDER BY bests.activity_id, bests.duration_s`,
};

export const TABLES: readonly LakeTable[] = [
  ACTIVITIES,
  RECORDS,
  LAPS,
  SESSIONS,
  TELEMETRY_META,
  POWER_CURVE,
];

function strava(sources: LakeSources): string {
  return sources.stravaExport === null ? STRAVA_ABSENT : stravaPresent(sources.stravaExport);
}

// Strava writes a handful of non-numeric markers into otherwise numeric
// columns. TRY_CAST leaves those cells null instead of failing the whole build.
function csvDouble(column: string): string {
  return `TRY_CAST(${quote(column)} AS DOUBLE)`;
}

function csvVarchar(column: string): string {
  return `CAST(${quote(column)} AS VARCHAR)`;
}
