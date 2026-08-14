import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type {
  TelemetryActivity,
  TelemetryLap,
  TelemetryRecord,
  TelemetrySession,
} from "../src/import/telemetry";
import { DECODE_CONCURRENCY, decodeBatch, type DecodeDeps } from "./decode";
import type { DecodeOutcome } from "../src/transform/protocol";
import { LAPS, RECORDS, SESSIONS, type Columns } from "./schema";
import type { LakeStore, RawStore } from "./storage";

let instance: DuckDBInstance;
let reader: DuckDBConnection;
let workspace: string;

beforeAll(async () => {
  instance = await DuckDBInstance.create();
  reader = await instance.connect();
  workspace = await mkdtemp(join(tmpdir(), "decode-test-"));
});

afterAll(async () => {
  reader.disconnectSync();
  await rm(workspace, { recursive: true, force: true });
});

test("returns exactly one outcome per work item, in input order", async () => {
  const { outcomes } = await decodeBatch(
    {
      work: [
        { activityId: "a", rawKeys: ["raw/a.fit.gz"] },
        { activityId: "b", rawKeys: ["raw/b.tcx.gz"] },
        { activityId: "c", rawKeys: ["raw/missing.fit"] },
        { activityId: "d", rawKeys: ["raw/d.gpx"] },
      ],
    },
    deps({ raw: { "raw/a.fit.gz": ride(), "raw/d.gpx": track() } }),
  );

  expect(outcomes.map((outcome) => outcome.activityId)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "ok",
    "skipped",
    "failed",
    "ok",
  ]);
});

test("skips an activity whose only raw key is not decodable telemetry", async () => {
  const { outcomes } = await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.tcx.gz", "raw/a.json"] }] },
    deps({}),
  );

  expect(outcomes[0]).toEqual({
    activityId: "a",
    status: "skipped",
    reason: "no decodable raw key among [raw/a.tcx.gz, raw/a.json]",
  });
});

test("skips an activity with no raw keys at all", async () => {
  const { outcomes } = await decodeBatch(
    { work: [{ activityId: "a", rawKeys: [] }] },
    deps({}),
  );

  expect(outcomes[0]?.status).toBe("skipped");
});

test("a throwing decode fails one activity and leaves the rest ok", async () => {
  const { outcomes } = await decodeBatch(
    {
      work: [
        { activityId: "a", rawKeys: ["raw/a.fit"] },
        { activityId: "b", rawKeys: ["raw/b.fit"] },
        { activityId: "c", rawKeys: ["raw/c.fit"] },
      ],
    },
    deps({
      raw: { "raw/a.fit": ride(), "raw/b.fit": ride(), "raw/c.fit": ride() },
      decode: async (_bytes, filename) => {
        if (filename === "raw/b.fit") {
          throw new Error("not a FIT file");
        }
        return ride();
      },
    }),
  );

  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "ok",
    "failed",
    "ok",
  ]);
  expect(failure(outcomes[1])).toContain("not a FIT file");
});

test("a missing raw object fails that activity with the key in the error", async () => {
  const { outcomes } = await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/gone.fit.gz"] }] },
    deps({}),
  );

  expect(outcomes[0]?.status).toBe("failed");
  expect(failure(outcomes[0])).toContain("raw/gone.fit.gz");
});

test("reports row counts and carries non-fatal decode errors through", async () => {
  const activity = ride();
  activity.errors = ["trackpoint 7: unparseable time"];

  const { outcomes } = await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.fit"] }] },
    deps({ raw: { "raw/a.fit": activity } }),
  );

  expect(outcomes[0]).toEqual({
    activityId: "a",
    status: "ok",
    outputKey: "decode/v1/a/",
    rawKey: "raw/a.fit",
    records: 2,
    laps: 1,
    sessions: 1,
    errors: ["trackpoint 7: unparseable time"],
  });
});

test("writes all four artifacts under the activity prefix, empty ones included", async () => {
  const lake = collectingLake();
  await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.gpx"] }] },
    deps({ raw: { "raw/a.gpx": track() }, lake }),
  );

  expect([...lake.written.keys()].sort()).toEqual([
    "decode/v1/a/laps.parquet",
    "decode/v1/a/meta.parquet",
    "decode/v1/a/records.parquet",
    "decode/v1/a/sessions.parquet",
  ]);
});

test("pins an identical column set whether or not the source produced rows", async () => {
  const lake = collectingLake();
  await decodeBatch(
    {
      work: [
        { activityId: "full", rawKeys: ["raw/full.fit"] },
        { activityId: "sparse", rawKeys: ["raw/sparse.gpx"] },
      ],
    },
    deps({ raw: { "raw/full.fit": ride(), "raw/sparse.gpx": track() }, lake }),
  );

  for (const table of ["records", "laps", "sessions", "meta"]) {
    expect(await schemaOf(lake, `full`, table)).toEqual(
      await schemaOf(lake, `sparse`, table),
    );
  }
});

test("writes the record schema derived from TelemetryRecord, activity_id first", async () => {
  const lake = collectingLake();
  await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.fit"] }] },
    deps({ raw: { "raw/a.fit": ride() }, lake }),
  );

  const schema = await schemaOf(lake, "a", "records");
  expect(schema[0]).toEqual({ name: "activity_id", type: "VARCHAR" });
  expect(schema.slice(1).map((column) => column.name)).toEqual(
    Object.keys(RECORDS.columns),
  );
  expect(new Map(schema.map((column) => [column.name, column.type]))).toEqual(
    new Map([
      ["activity_id", "VARCHAR"],
      ["timestamp", "TIMESTAMP"],
      ["position_lat", "DOUBLE"],
      ["position_lon", "DOUBLE"],
      ["altitude", "DOUBLE"],
      ["distance", "DOUBLE"],
      ["speed", "DOUBLE"],
      ["power", "DOUBLE"],
      ["cadence", "DOUBLE"],
      ["heart_rate", "DOUBLE"],
      ["temperature", "DOUBLE"],
      ["grade", "DOUBLE"],
      ["left_right_balance", "DOUBLE"],
      ["accumulated_power", "DOUBLE"],
      ["gps_accuracy", "DOUBLE"],
      ["segment", "INTEGER"],
      ["developer_fields", "VARCHAR"],
    ]),
  );
});

test("round-trips record values and row counts through Parquet", async () => {
  const lake = collectingLake();
  await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.fit"] }] },
    deps({ raw: { "raw/a.fit": ride() }, lake }),
  );

  const rows = await rowsOf(lake, "a", "records");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    activity_id: "a",
    timestamp: "2026-03-04 05:06:07",
    position_lat: 45.5,
    position_lon: -122.6,
    power: 240,
    segment: 0,
  });
  expect(rows[1]).toMatchObject({ power: null, segment: 1 });

  expect(await rowsOf(lake, "a", "laps")).toHaveLength(1);
  expect(await rowsOf(lake, "a", "sessions")).toHaveLength(1);
});

test("keeps developer_fields as parseable JSON keyed on the resolved name", async () => {
  const lake = collectingLake();
  await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.fit"] }] },
    deps({ raw: { "raw/a.fit": ride() }, lake }),
  );

  const [first, second] = await rowsOf(lake, "a", "records");
  expect(JSON.parse(String(first?.developer_fields))).toEqual({
    leg_spring_stiffness: 8.5,
    stryd_tags: ["a", "b"],
  });
  expect(second?.developer_fields).toBeNull();
});

test("describes the device and every developer field in meta", async () => {
  const lake = collectingLake();
  await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.fit"] }] },
    deps({ raw: { "raw/a.fit": ride() }, lake }),
  );

  const rows = await rowsOf(lake, "a", "meta");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    kind: "device",
    source: "fit",
    manufacturer: "garmin",
    product_name: "Edge 530",
  });
  expect(rows[1]).toMatchObject({
    kind: "developer_field",
    name: "leg_spring_stiffness",
    field_name: "leg_spring_stiffness",
    units: "kN/m",
  });
});

test("writes a device row even for a source that names no device", async () => {
  const lake = collectingLake();
  await decodeBatch(
    { work: [{ activityId: "a", rawKeys: ["raw/a.gpx"] }] },
    deps({ raw: { "raw/a.gpx": track() }, lake }),
  );

  const rows = await rowsOf(lake, "a", "meta");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "device",
    source: "gpx",
    manufacturer: null,
  });
});

test("holds decodes to the concurrency limit", async () => {
  let running = 0;
  let peak = 0;

  await decodeBatch(
    {
      work: Array.from({ length: 20 }, (_unused, index) => ({
        activityId: `a${index}`,
        rawKeys: [`raw/a${index}.fit`],
      })),
    },
    deps({
      raw: Object.fromEntries(
        Array.from({ length: 20 }, (_unused, index) => [
          `raw/a${index}.fit`,
          track(),
        ]),
      ),
      decode: async (_bytes, _filename) => {
        running++;
        peak = Math.max(peak, running);
        await Bun.sleep(1);
        running--;
        return track();
      },
    }),
  );

  expect(peak).toBe(DECODE_CONCURRENCY);
});

interface StubOptions {
  raw?: Record<string, TelemetryActivity>;
  lake?: LakeStore;
  decode?: DecodeDeps["decode"];
}

// The raw store maps a key to the activity its bytes decode to, so a stub
// decoder can stand in for the real one without any encoded fixture.
function deps(options: StubOptions): DecodeDeps {
  const activities = options.raw ?? {};
  const raw: RawStore = {
    async get(key) {
      if (activities[key] === undefined) {
        throw new Error(`NoSuchKey: ${key}`);
      }
      return new TextEncoder().encode(key);
    },
  };

  return {
    raw,
    lake: options.lake ?? collectingLake(),
    instance,
    decode:
      options.decode ??
      (async (bytes) => {
        const key = new TextDecoder().decode(bytes);
        const activity = activities[key];
        if (activity === undefined) {
          throw new Error(`no stub activity for ${key}`);
        }
        return activity;
      }),
  };
}

interface CollectingLake extends LakeStore {
  written: Map<string, string>;
}

// The container deletes its scratch directory as soon as the uploads resolve,
// so the stub has to take its own copy to leave anything to assert against.
function collectingLake(): CollectingLake {
  const written = new Map<string, string>();
  return {
    written,
    async put(key, path) {
      const copy = join(workspace, `${written.size}-${basename(path)}`);
      await copyFile(path, copy);
      written.set(key, copy);
    },
  };
}

interface SchemaColumn {
  name: string;
  type: string;
}

async function schemaOf(
  lake: CollectingLake,
  activityId: string,
  table: string,
): Promise<SchemaColumn[]> {
  const result = await reader.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet(${literal(parquet(lake, activityId, table))})`,
  );
  return result.getRowObjectsJson().map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
}

async function rowsOf(
  lake: CollectingLake,
  activityId: string,
  table: string,
): Promise<Record<string, unknown>[]> {
  const result = await reader.runAndReadAll(
    `SELECT * FROM read_parquet(${literal(parquet(lake, activityId, table))})`,
  );
  return result.getRowObjectsJson();
}

function parquet(
  lake: CollectingLake,
  activityId: string,
  table: string,
): string {
  const path = lake.written.get(`decode/v1/${activityId}/${table}.parquet`);
  if (path === undefined) {
    throw new Error(`no ${table} artifact for ${activityId}`);
  }
  return path;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function failure(outcome: DecodeOutcome | undefined): string {
  return outcome?.status === "failed" ? outcome.error : "";
}

// Rows are built from the schema's own column list so a field added to a
// telemetry interface shows up here as a null rather than a type error the
// fixture papers over.
function nulls<R>(columns: Columns<R>): { [K in keyof R]: null } {
  const row: Record<string, null> = {};
  for (const name of Object.keys(columns)) {
    row[name] = null;
  }
  return row as { [K in keyof R]: null };
}

function ride(): TelemetryActivity {
  const first: TelemetryRecord = {
    ...nulls(RECORDS.columns),
    timestamp: new Date("2026-03-04T05:06:07Z"),
    position_lat: 45.5,
    position_lon: -122.6,
    power: 240,
    cadence: 88.5,
    segment: 0,
    developer_fields: { leg_spring_stiffness: 8.5, stryd_tags: ["a", "b"] },
  };
  const second: TelemetryRecord = {
    ...nulls(RECORDS.columns),
    timestamp: new Date("2026-03-04T05:06:08Z"),
    segment: 1,
  };
  const lap: TelemetryLap = {
    ...nulls(LAPS.columns),
    total_distance: 1000,
    sport: "cycling",
  };
  const session: TelemetrySession = {
    ...nulls(SESSIONS.columns),
    total_distance: 1000,
    sport: "cycling",
  };

  return {
    source: "fit",
    records: [first, second],
    laps: [lap],
    sessions: [session],
    device: {
      manufacturer: "garmin",
      product: "edge_530",
      product_name: "Edge 530",
      serial_number: 3_912_345_678,
      software_version: 9.35,
      hardware_version: 1,
      time_created: new Date("2026-03-04T05:00:00Z"),
    },
    developerFields: [
      {
        name: "leg_spring_stiffness",
        field_name: "leg_spring_stiffness",
        developer_data_index: 0,
        field_definition_number: 3,
        units: "kN/m",
        base_type_id: 136,
        native_mesg_num: null,
      },
    ],
    errors: [],
  };
}

function track(): TelemetryActivity {
  return {
    source: "gpx",
    records: [
      {
        ...nulls(RECORDS.columns),
        timestamp: new Date("2026-03-04T05:06:07Z"),
        position_lat: 45.5,
        position_lon: -122.6,
        segment: 0,
      },
    ],
    laps: [],
    sessions: [],
    device: null,
    developerFields: [],
    errors: [],
  };
}
