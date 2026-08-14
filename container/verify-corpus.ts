// Builds the lake from the local Strava export: decodes each activity file
// into the same per-activity Parquet layout the container writes, synthesizes
// the registry snapshot the Worker would export from D1, then runs the real
// lake build over both. Everything stays on disk, so this exercises the SQL
// without R2 or a container.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { writeActivityParquet } from "./parquet";
import { decodeTelemetry } from "../src/import/telemetry";
import { buildLake } from "./lake";

const EXPORT = process.argv[2];
const WORK = process.argv[3];
const LIMIT = Number(process.argv[4] ?? "0");

if (!EXPORT || !WORK) {
  throw new Error("usage: local-lake.ts <export-dir> <work-dir> [limit]");
}

const DECODABLE = /\.(fit|gpx)(\.gz)?$/i;
// Raw keys are synthesized so telemetry provenance comes out the same as it
// would in production, and the archive's date is the directory it unpacked to.
const EXPORT_DATE = EXPORT.replace(/\/$/, "").split("/").pop();
const DECODE = join(WORK, "decode");
const OUTPUT = join(WORK, "lake");
const REGISTRY = join(WORK, "registry.ndjson");

await rm(WORK, { recursive: true, force: true });
await mkdir(DECODE, { recursive: true });
// DuckDB creates the table directory but not its parents. On S3 there are no
// directories to create, so this is local-only setup.
await mkdir(OUTPUT, { recursive: true });

const files = (await readdir(join(EXPORT, "activities")))
  .filter((name) => DECODABLE.test(name))
  .sort();
const selected = LIMIT > 0 ? files.slice(0, LIMIT) : files;
console.log(`decoding ${selected.length} of ${files.length} export files`);

const instance = await DuckDBInstance.create(":memory:");

// An export file is named by its upload id. The CSV's Filename column is the
// only thing that maps a file to the activity it belongs to, and deriving the
// id from the basename silently mismatches every row.
const csv = join(EXPORT, "activities.csv");
const catalog = await instance.connect();
const catalogRows = await catalog.runAndReadAll(
  `SELECT CAST("Activity ID" AS VARCHAR) AS activity_id,
          regexp_extract("Filename", '([^/]+)$', 1) AS file,
          strftime(strptime("Activity Date", '%b %d, %Y, %-I:%M:%S %p'), '%Y-%m-%dT%H:%M:%S') AS started_at,
          "Activity Type" AS sport,
          "Elapsed Time_1" AS duration_s
   FROM read_csv('${csv}', header = true, null_padding = true, parallel = false)
   WHERE "Filename" IS NOT NULL`,
);
const byFile = new Map(
  catalogRows.getRowObjects().map((row) => [String(row.file), row]),
);
console.log(`csv maps ${byFile.size} files to activity ids`);

const registry: string[] = [];
let failures = 0;
let records = 0;
let unmapped = 0;

for (const [index, file] of selected.entries()) {
  const entry = byFile.get(file);
  if (entry === undefined) {
    unmapped += 1;
    continue;
  }
  const activityId = String(entry.activity_id);
  const rawKey = `raw/strava/export/${EXPORT_DATE}/activities/${file}`;
  const path = join(EXPORT, "activities", file);

  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const activity = await decodeTelemetry(bytes, file);
    const directory = join(DECODE, activityId);
    await mkdir(directory, { recursive: true });
    await writeActivityParquet(
      instance,
      directory,
      activityId,
      rawKey,
      activity,
    );
    records += activity.records.length;

    registry.push(
      JSON.stringify({
        activity_id: activityId,
        started_at: String(entry.started_at),
        timezone: "America/Los_Angeles",
        sport: String(entry.sport),
        duration_s: Number(entry.duration_s ?? 0),
        strava_id: activityId,
        wahoo_id: null,
        deleted_at: null,
      }),
    );
  } catch (error) {
    failures += 1;
    console.log(`  failed ${file}: ${String(error)}`);
  }

  if ((index + 1) % 500 === 0) {
    console.log(`  ${index + 1}/${selected.length}`);
  }
}

await writeFile(REGISTRY, `${registry.join("\n")}\n`);
console.log(
  `decoded ${registry.length} activities, ${records} records, ${failures} failures, ${unmapped} files absent from the csv`,
);

const response = await buildLake(
  { decode: DECODE, registry: REGISTRY, stravaExport: csv, output: OUTPUT },
  { instance },
);
console.log(JSON.stringify(response, null, 2));

const connection = await instance.connect();
const show = async (label: string, sql: string) => {
  const reader = await connection.runAndReadAll(sql);
  const rows = JSON.stringify(
    reader.getRowObjects(),
    (_, value) => (typeof value === "bigint" ? Number(value) : value),
    2,
  );
  console.log(`\n== ${label}\n${rows}`);
};

await show(
  "provenance",
  `SELECT telemetry_origin, telemetry_format, power_source, COUNT(*) AS activities
   FROM read_parquet('${OUTPUT}/activities/**/*.parquet')
   GROUP BY ALL ORDER BY activities DESC`,
);
await show(
  "join coverage",
  `SELECT COUNT(*) AS activities,
          COUNT(name) AS with_strava_row,
          COUNT(device_distance_m) AS with_device_totals
   FROM read_parquet('${OUTPUT}/activities/**/*.parquet')`,
);
await show(
  "strava vs device",
  `SELECT COUNT(*) AS compared,
          ROUND(MEDIAN(ABS(strava_distance_m - device_distance_m)), 1) AS median_abs_distance_diff_m,
          ROUND(MEDIAN(ABS(strava_weighted_avg_power_w - device_normalized_power_w)), 1) AS median_abs_np_diff_w
   FROM read_parquet('${OUTPUT}/activities/**/*.parquet')
   WHERE strava_distance_m IS NOT NULL AND device_distance_m IS NOT NULL`,
);
await show(
  "record column types",
  `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet('${OUTPUT}/records/**/*.parquet')) LIMIT 4`,
);
