import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildLake } from "./lake";
import { writeActivityParquet } from "./parquet";
import type {
  TelemetryActivity,
  TelemetryRecord,
} from "../src/import/telemetry";

let instance: DuckDBInstance;
let work: string;

beforeEach(async () => {
  instance = await DuckDBInstance.create(":memory:");
  work = await mkdtemp(join(tmpdir(), "lake-"));
  await mkdir(join(work, "decode"), { recursive: true });
  await mkdir(join(work, "out"), { recursive: true });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function record(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    timestamp: new Date("2026-01-01T14:00:00.000Z"),
    position_lat: 37.7,
    position_lon: -122.4,
    altitude: 10,
    distance: 100,
    speed: 5,
    power: null,
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

function activity(
  overrides: Partial<TelemetryActivity> = {},
): TelemetryActivity {
  return {
    source: "fit",
    records: [record()],
    laps: [],
    sessions: [],
    device: null,
    developerFields: [],
    errors: [],
    ...overrides,
  };
}

interface Seed {
  activityId: string;
  rawKey: string;
  activity: TelemetryActivity;
}

async function seed(seeds: Seed[], registry: object[]): Promise<void> {
  for (const item of seeds) {
    const directory = join(work, "decode", item.activityId);
    await mkdir(directory, { recursive: true });
    await writeActivityParquet(
      instance,
      directory,
      item.activityId,
      item.rawKey,
      item.activity,
    );
  }
  await writeFile(
    join(work, "registry.ndjson"),
    `${registry.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function registryRow(activityId: string, stravaId: string | null = null) {
  return {
    activity_id: activityId,
    started_at: "2026-01-01T14:00:00",
    timezone: "America/Los_Angeles",
    sport: "ride",
    duration_s: 3600,
    strava_id: stravaId,
    wahoo_id: null,
    deleted_at: null,
  };
}

async function build(stravaExport: string | null = null) {
  return buildLake(
    {
      decode: join(work, "decode"),
      registry: join(work, "registry.ndjson"),
      stravaExport,
      output: join(work, "out"),
    },
    { instance },
  );
}

async function activities(): Promise<Record<string, unknown>[]> {
  const connection = await instance.connect();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM read_parquet('${join(work, "out")}/activities/**/*.parquet')`,
  );
  return reader.getRowObjects();
}

// Read off the files rather than the COPY's own count, which reports what this
// run wrote and says nothing about what an earlier one left behind.
async function recordYears(): Promise<number[]> {
  const connection = await instance.connect();
  const reader = await connection.runAndReadAll(
    `SELECT DISTINCT year FROM read_parquet('${join(work, "out")}/records/**/*.parquet', hive_partitioning = true) ORDER BY year`,
  );
  return reader.getRowObjects().map((row) => Number(row.year));
}

test("unions every activity's rows into one table per grain", async () => {
  await seed(
    [
      { activityId: "a", rawKey: "raw/wahoo/a.fit", activity: activity() },
      {
        activityId: "b",
        rawKey: "raw/strava/b.fit",
        activity: activity({ records: [record(), record()] }),
      },
    ],
    [registryRow("a"), registryRow("b")],
  );

  const response = await build();

  expect(
    Object.fromEntries(response.tables.map((t) => [t.name, t.rows])),
  ).toEqual({ activities: 2, records: 3, laps: 0, sessions: 0, meta: 2 });
});

test("reads telemetry provenance off the raw key that produced the rows", async () => {
  await seed(
    [
      {
        activityId: "a",
        rawKey: "raw/wahoo/workouts/1/original.fit",
        activity: activity(),
      },
      {
        activityId: "b",
        rawKey: "raw/strava/export/2026-07-16/activities/2.fit.gz",
        activity: activity(),
      },
      {
        activityId: "c",
        rawKey: "raw/strava/activities/3/original.fit.gz",
        activity: activity(),
      },
    ],
    [registryRow("a"), registryRow("b"), registryRow("c")],
  );

  await build();

  expect(
    (await activities()).map((row) => [row.activity_id, row.telemetry_origin]),
  ).toEqual([
    ["a", "wahoo"],
    ["b", "strava_export"],
    ["c", "strava"],
  ]);
});

test("calls GPX power estimated and FIT power measured", async () => {
  await seed(
    [
      {
        activityId: "gpx",
        rawKey: "raw/strava/gpx.gpx",
        activity: activity({
          source: "gpx",
          records: [record({ power: 200 })],
        }),
      },
      {
        activityId: "fit",
        rawKey: "raw/strava/fit.fit",
        activity: activity({ records: [record({ power: 200 })] }),
      },
      {
        activityId: "none",
        rawKey: "raw/strava/none.fit",
        activity: activity(),
      },
    ],
    [registryRow("gpx"), registryRow("fit"), registryRow("none")],
  );

  await build();

  expect(
    Object.fromEntries(
      (await activities()).map((row) => [row.activity_id, row.power_source]),
    ),
  ).toEqual({ gpx: "estimated", fit: "measured", none: "none" });
});

// An activity the registry holds but nothing decoded still belongs in the
// table. Dropping it would read as a lost ride.
test("keeps a registry activity that has no telemetry", async () => {
  await seed([], [registryRow("orphan")]);

  const response = await build();

  expect(response.tables.find((t) => t.name === "activities")?.rows).toBe(1);
  const [row] = await activities();
  expect(row?.telemetry_origin).toBeNull();
  expect(row?.power_source).toBe("none");
});

test("joins Strava's own numbers on the registry's Strava id", async () => {
  const csv = join(work, "activities.csv");
  await writeFile(
    csv,
    [
      "Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Average Speed,Elevation Gain,Elevation Loss,Elevation Low,Elevation High,Max Grade,Average Grade,Average Positive Grade,Average Negative Grade,Max Cadence,Average Cadence,Max Heart Rate,Average Heart Rate,Max Watts,Average Watts,Calories,Max Temperature,Average Temperature,Relative Effort,Total Work,Number of Runs,Uphill Time,Downhill Time,Other Time,Perceived Exertion,Type,Start Time,Weighted Average Power,Power Count,Prefer Perceived Exertion,Perceived Relative Effort,Commute,Total Weight Lifted,From Upload,Grade Adjusted Distance",
      '9911,"Jan 1, 2026, 2:00:00 PM",Morning Ride,Ride,,3600,42.5,180,90,false,,Bike,activities/1.fit.gz,75,8,3600,3400,42500,12.5,9.1,320,310,10,330,8,1.2,3,-3,95,82,180,150,420,210,900,25,18,90,760000,0,0,0,0,,Ride,,225,3400,false,0,false,0,true,42500',
    ].join("\n"),
  );

  await seed(
    [{ activityId: "a", rawKey: "raw/strava/a.fit", activity: activity() }],
    [registryRow("a", "9911")],
  );

  await build(csv);

  const [row] = await activities();
  expect(row?.name).toBe("Morning Ride");
  expect(row?.strava_distance_m).toBe(42500);
  expect(row?.strava_weighted_avg_power_w).toBe(225);
});

// The lake has to build before any export is ever archived, so every Strava
// column resolves to null.
test("builds with no export archived", async () => {
  await seed(
    [{ activityId: "a", rawKey: "raw/strava/a.fit", activity: activity() }],
    [registryRow("a", "9911")],
  );

  await build(null);

  const [row] = await activities();
  expect(row?.activity_id).toBe("a");
  expect(row?.strava_distance_m).toBeNull();
});

test("carries the registry's own duration", async () => {
  await seed(
    [{ activityId: "a", rawKey: "raw/strava/a.fit", activity: activity() }],
    [registryRow("a"), registryRow("orphan")],
  );

  await build();

  expect(
    Object.fromEntries(
      (await activities()).map((r) => [r.activity_id, r.duration_s]),
    ),
  ).toEqual({ a: 3600, orphan: 3600 });
});

// A year that loses its last record has to stop being served. COPY only
// rewrites the partitions the current run produces, so the previous run's
// directory survives unless the write is told to clear the destination.
test("stops serving a partition that lost its last row", async () => {
  const record2024 = record({
    timestamp: new Date("2024-06-01T14:00:00.000Z"),
  });
  await seed(
    [
      { activityId: "a", rawKey: "raw/strava/a.fit", activity: activity() },
      {
        activityId: "old",
        rawKey: "raw/strava/old.fit",
        activity: activity({ records: [record2024] }),
      },
    ],
    [registryRow("a"), registryRow("old")],
  );
  await build();
  expect(await recordYears()).toEqual([2024, 2026]);

  await rm(join(work, "decode", "old"), { recursive: true });
  await writeFile(
    join(work, "registry.ndjson"),
    `${JSON.stringify(registryRow("a"))}\n`,
  );
  await build();

  expect(await recordYears()).toEqual([2026]);
});

// The build rewrites every table, so a table that shrinks must not keep
// serving the rows the previous run left behind.
test("replaces the previous run's files", async () => {
  await seed(
    [
      { activityId: "a", rawKey: "raw/strava/a.fit", activity: activity() },
      { activityId: "b", rawKey: "raw/strava/b.fit", activity: activity() },
    ],
    [registryRow("a"), registryRow("b")],
  );
  await build();

  await rm(join(work, "decode", "b"), { recursive: true });
  await writeFile(
    join(work, "registry.ndjson"),
    `${JSON.stringify(registryRow("a"))}\n`,
  );
  const response = await build();

  expect(response.tables.find((t) => t.name === "activities")?.rows).toBe(1);
  expect(response.tables.find((t) => t.name === "records")?.rows).toBe(1);
});
