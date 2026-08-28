import { timestampValue, type DuckDBAppender } from "@duckdb/node-api";
import type {
  DeveloperFieldDescriptor,
  TelemetryActivity,
  TelemetryDevice,
  TelemetryLap,
  TelemetryRecord,
  TelemetrySession,
  TelemetrySource,
} from "../src/import/telemetry";
import { quote } from "./sql";

// Every numeric telemetry column is DOUBLE rather than a width matched to the
// field's FIT profile type. A double is exact for every integer the decoders
// can produce, and one rule for every column is what keeps the schema
// identical across activities: a per-column judgement about integrality is a
// judgement that can be made differently by whoever adds the next column.
// `JSON` is a logical type stored as VARCHAR, so `developer_fields` unions
// across activities whose descriptor sets differ.
export type ColumnType =
  | "VARCHAR"
  | "VARCHAR NOT NULL"
  | "DOUBLE"
  | "INTEGER NOT NULL"
  | "TIMESTAMP"
  | "JSON";

export type Columns<R> = { [K in keyof R]-?: ColumnType };

export interface Table<R> {
  name: string;
  columns: Columns<R>;
}

export type MetaKind = "device" | "developer_field";

// `meta.parquet` holds two row shapes discriminated by `kind`: exactly one
// `device` row per activity, written even when the file named no device, and
// one `developer_field` row per descriptor.
export interface MetaRow {
  kind: MetaKind;
  source: TelemetrySource;
  // The raw object these rows were decoded from. `source` says the format;
  // this says which of an activity's files won, which is what separates a
  // Wahoo upload from the same ride's Strava export copy.
  raw_key: string;
  manufacturer: string | null;
  product: string | null;
  product_name: string | null;
  serial_number: number | null;
  software_version: number | null;
  hardware_version: number | null;
  time_created: Date | null;
  name: string | null;
  field_name: string | null;
  developer_data_index: number | null;
  field_definition_number: number | null;
  units: string | null;
  base_type_id: number | null;
  native_mesg_num: number | null;
}

export const RECORDS: Table<TelemetryRecord> = {
  name: "records",
  columns: {
    timestamp: "TIMESTAMP",
    position_lat: "DOUBLE",
    position_lon: "DOUBLE",
    altitude: "DOUBLE",
    distance: "DOUBLE",
    speed: "DOUBLE",
    power: "DOUBLE",
    cadence: "DOUBLE",
    heart_rate: "DOUBLE",
    temperature: "DOUBLE",
    grade: "DOUBLE",
    left_right_balance: "DOUBLE",
    accumulated_power: "DOUBLE",
    gps_accuracy: "DOUBLE",
    segment: "INTEGER NOT NULL",
    developer_fields: "JSON",
  },
};

export const LAPS: Table<TelemetryLap> = {
  name: "laps",
  columns: {
    message_index: "DOUBLE",
    timestamp: "TIMESTAMP",
    start_time: "TIMESTAMP",
    start_position_lat: "DOUBLE",
    start_position_lon: "DOUBLE",
    end_position_lat: "DOUBLE",
    end_position_lon: "DOUBLE",
    total_elapsed_time: "DOUBLE",
    total_timer_time: "DOUBLE",
    total_moving_time: "DOUBLE",
    total_distance: "DOUBLE",
    total_calories: "DOUBLE",
    total_work: "DOUBLE",
    total_ascent: "DOUBLE",
    total_descent: "DOUBLE",
    avg_speed: "DOUBLE",
    max_speed: "DOUBLE",
    avg_heart_rate: "DOUBLE",
    max_heart_rate: "DOUBLE",
    min_heart_rate: "DOUBLE",
    avg_cadence: "DOUBLE",
    max_cadence: "DOUBLE",
    avg_power: "DOUBLE",
    max_power: "DOUBLE",
    normalized_power: "DOUBLE",
    avg_altitude: "DOUBLE",
    min_altitude: "DOUBLE",
    max_altitude: "DOUBLE",
    avg_grade: "DOUBLE",
    avg_temperature: "DOUBLE",
    max_temperature: "DOUBLE",
    intensity: "VARCHAR",
    lap_trigger: "VARCHAR",
    sport: "VARCHAR",
    sub_sport: "VARCHAR",
    developer_fields: "JSON",
  },
};

export const SESSIONS: Table<TelemetrySession> = {
  name: "sessions",
  columns: {
    message_index: "DOUBLE",
    timestamp: "TIMESTAMP",
    start_time: "TIMESTAMP",
    start_position_lat: "DOUBLE",
    start_position_lon: "DOUBLE",
    end_position_lat: "DOUBLE",
    end_position_lon: "DOUBLE",
    sport: "VARCHAR",
    sub_sport: "VARCHAR",
    total_elapsed_time: "DOUBLE",
    total_timer_time: "DOUBLE",
    total_moving_time: "DOUBLE",
    total_distance: "DOUBLE",
    total_calories: "DOUBLE",
    total_work: "DOUBLE",
    total_ascent: "DOUBLE",
    total_descent: "DOUBLE",
    avg_speed: "DOUBLE",
    max_speed: "DOUBLE",
    avg_heart_rate: "DOUBLE",
    max_heart_rate: "DOUBLE",
    min_heart_rate: "DOUBLE",
    avg_cadence: "DOUBLE",
    max_cadence: "DOUBLE",
    avg_power: "DOUBLE",
    max_power: "DOUBLE",
    normalized_power: "DOUBLE",
    threshold_power: "DOUBLE",
    training_stress_score: "DOUBLE",
    intensity_factor: "DOUBLE",
    total_training_effect: "DOUBLE",
    avg_altitude: "DOUBLE",
    min_altitude: "DOUBLE",
    max_altitude: "DOUBLE",
    avg_grade: "DOUBLE",
    avg_temperature: "DOUBLE",
    max_temperature: "DOUBLE",
    num_laps: "DOUBLE",
    first_lap_index: "DOUBLE",
    trigger: "VARCHAR",
    developer_fields: "JSON",
  },
};

export const META: Table<MetaRow> = {
  name: "meta",
  columns: {
    kind: "VARCHAR NOT NULL",
    source: "VARCHAR NOT NULL",
    raw_key: "VARCHAR NOT NULL",
    manufacturer: "VARCHAR",
    product: "VARCHAR",
    product_name: "VARCHAR",
    serial_number: "DOUBLE",
    software_version: "DOUBLE",
    hardware_version: "DOUBLE",
    time_created: "TIMESTAMP",
    name: "VARCHAR",
    field_name: "VARCHAR",
    developer_data_index: "DOUBLE",
    field_definition_number: "DOUBLE",
    units: "VARCHAR",
    base_type_id: "DOUBLE",
    native_mesg_num: "DOUBLE",
  },
};

// Prefixed to every table so a glob over `decode/v1/*/records.parquet` carries
// the activity without reparsing object keys out of `filename`.
const ACTIVITY_ID = "activity_id";

export function metaRows(activity: TelemetryActivity, rawKey: string): MetaRow[] {
  return [
    deviceRow(activity.source, rawKey, activity.device),
    ...activity.developerFields.map((descriptor) =>
      developerFieldRow(activity.source, rawKey, descriptor),
    ),
  ];
}

function deviceRow(
  source: TelemetrySource,
  rawKey: string,
  device: TelemetryDevice | null,
): MetaRow {
  return {
    kind: "device",
    source,
    raw_key: rawKey,
    manufacturer: device?.manufacturer ?? null,
    product: device?.product ?? null,
    product_name: device?.product_name ?? null,
    serial_number: device?.serial_number ?? null,
    software_version: device?.software_version ?? null,
    hardware_version: device?.hardware_version ?? null,
    time_created: device?.time_created ?? null,
    name: null,
    field_name: null,
    developer_data_index: null,
    field_definition_number: null,
    units: null,
    base_type_id: null,
    native_mesg_num: null,
  };
}

function developerFieldRow(
  source: TelemetrySource,
  rawKey: string,
  descriptor: DeveloperFieldDescriptor,
): MetaRow {
  return {
    kind: "developer_field",
    source,
    raw_key: rawKey,
    manufacturer: null,
    product: null,
    product_name: null,
    serial_number: null,
    software_version: null,
    hardware_version: null,
    time_created: null,
    name: descriptor.name,
    field_name: descriptor.field_name,
    developer_data_index: descriptor.developer_data_index,
    field_definition_number: descriptor.field_definition_number,
    units: descriptor.units,
    base_type_id: descriptor.base_type_id,
    native_mesg_num: descriptor.native_mesg_num,
  };
}

// A relation with the decode artifact's exact shape and no rows. The lake
// build substitutes it when no activity has been decoded yet, because a glob
// matching no files is an error in DuckDB rather than an empty scan, and the
// first build necessarily runs before any decode has landed.
export function emptySelectSql<R>(table: Table<R>): string {
  const columns = [
    `NULL::VARCHAR AS ${quote(ACTIVITY_ID)}`,
    ...columnNames(table).map((name) => `NULL::${castType(table.columns[name])} AS ${quote(name)}`),
  ];
  return `SELECT * FROM (SELECT ${columns.join(", ")}) WHERE false`;
}

export function createTableSql<R>(table: Table<R>): string {
  const columns = columnNames(table).map(
    (name) => `${quote(name)} ${storageType(table.columns[name])}`,
  );
  return `CREATE TEMP TABLE ${quote(table.name)} (${quote(ACTIVITY_ID)} VARCHAR NOT NULL, ${columns.join(", ")})`;
}

export function appendRows<R extends object>(
  appender: DuckDBAppender,
  table: Table<R>,
  activityId: string,
  rows: readonly R[],
): void {
  const names = columnNames(table);
  for (const row of rows) {
    appender.appendVarchar(activityId);
    for (const name of names) {
      appendCell(appender, table.columns[name], row[name]);
    }
    appender.endRow();
  }
}

function appendCell(appender: DuckDBAppender, type: ColumnType, value: unknown): void {
  if (value == null) {
    appender.appendNull();
    return;
  }
  switch (type) {
    case "JSON":
      appender.appendVarchar(JSON.stringify(value));
      return;
    case "VARCHAR":
    case "VARCHAR NOT NULL":
      appender.appendVarchar(String(value));
      return;
    case "TIMESTAMP":
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        appender.appendTimestamp(timestampValue(BigInt(value.getTime()) * 1000n));
      } else {
        appender.appendNull();
      }
      return;
    case "DOUBLE":
      if (typeof value === "number" && Number.isFinite(value)) {
        appender.appendDouble(value);
      } else {
        appender.appendNull();
      }
      return;
    case "INTEGER NOT NULL":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`expected an integer, got ${String(value)}`);
      }
      appender.appendInteger(value);
      return;
  }
}

function columnNames<R>(table: Table<R>): (keyof R & string)[] {
  return Object.keys(table.columns) as (keyof R & string)[];
}

function storageType(type: ColumnType): string {
  return type === "JSON" ? "VARCHAR" : type;
}

// A cast names a type and cannot carry a constraint, so the nullability that
// belongs in a column definition is dropped here.
function castType(type: ColumnType): string {
  return storageType(type).replace(" NOT NULL", "");
}
