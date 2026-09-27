#!/usr/bin/env bun
// Fills activity_sources.indoor for sources ingested before migration 0008
// added the column. Each source's type is read from wherever that source
// archived it: Strava's detail.json where the webhook stored one, otherwise
// the bulk export's activity type, and Wahoo's summary.json. The export has no
// trainer column, so a trainer ride that only the export describes stays
// outdoor here unless its FIT says otherwise, which publish reads for itself.
//
// Only the column moves. `updated_at` stays put so nothing re-decodes, and the
// corpus republish that carries the flag to the site is a separate step.
//
// Reads R2 over its S3 API with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
// set to the raw bucket's credential pair.
//
// Usage: bun scripts/backfill-indoor.ts <export-dir> [--dry-run]
import path from "node:path";
import { parseArgs } from "node:util";
import { S3Client } from "bun";
import { parseActivitiesCsv } from "../src/import/csv";
import { indoorFromStrava, indoorFromWahoo } from "../src/sport";
import { isWorkoutSummary } from "../src/wahoo/summary";

const BUCKET = "activity-hub-raw";
const DATABASE = "activity-hub-registry";
const S3_ENDPOINT = "https://72bdc77341dc52a3cf4a94097f9ad96f.r2.cloudflarestorage.com";
const READ_CONCURRENCY = 16;
// Keeps each statement's IN list well under D1's statement size limit.
const IDS_PER_STATEMENT = 500;

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const exportDir = positionals[0];
if (!exportDir) {
  console.error("usage: bun scripts/backfill-indoor.ts <export-dir> [--dry-run]");
  process.exit(1);
}

const exportTypes = new Map(
  parseActivitiesCsv(await Bun.file(path.join(exportDir, "activities.csv")).text()).map(
    (activity) => [activity.sourceId, activity.sportType],
  ),
);

const bucket = new S3Client({ bucket: BUCKET, endpoint: S3_ENDPOINT });

interface SourceRow {
  source: string;
  source_id: string;
  activity_id: string;
  raw_keys: string;
}

interface Classified {
  row: SourceRow;
  indoor: boolean | null;
  // What decided it, for the report.
  basis: string;
}

const rows = query(
  "SELECT source, source_id, activity_id, raw_keys FROM activity_sources WHERE indoor IS NULL",
) as unknown as SourceRow[];
console.log(`${rows.length} sources without an indoor flag`);

const classified: Classified[] = [];
const queue = [...rows];
await Promise.all(Array.from({ length: READ_CONCURRENCY }, classifyNext));

// Each worker takes the next row only once its read settles.
async function classifyNext(): Promise<void> {
  const row = queue.shift();
  if (row === undefined) {
    return;
  }
  classified.push(await classify(row));
  if (classified.length % 500 === 0) {
    console.log(`classified ${classified.length}/${rows.length}`);
  }
  return classifyNext();
}

async function classify(row: SourceRow): Promise<Classified> {
  const keys = JSON.parse(row.raw_keys) as Record<string, string>;
  if (row.source === "strava") {
    if (keys.detail !== undefined) {
      const detail = (await bucket.file(keys.detail).json()) as Record<string, unknown>;
      if (typeof detail.sport_type === "string") {
        return {
          row,
          indoor: indoorFromStrava(detail.sport_type, detail.trainer === true),
          basis: `strava detail ${detail.sport_type}${detail.trainer === true ? " trainer" : ""}`,
        };
      }
    }
    const sportType = exportTypes.get(row.source_id);
    if (sportType !== undefined) {
      return {
        row,
        indoor: indoorFromStrava(sportType, false),
        basis: `strava export ${sportType}`,
      };
    }
    return { row, indoor: null, basis: "strava: no detail and not in the export" };
  }
  if (row.source === "wahoo" && keys.summary !== undefined) {
    const summary: unknown = await bucket.file(keys.summary).json();
    if (isWorkoutSummary(summary)) {
      const type = summary.workout.workout_type_id;
      return { row, indoor: indoorFromWahoo(type), basis: `wahoo type ${type}` };
    }
    return { row, indoor: null, basis: "wahoo: unreadable summary" };
  }
  return { row, indoor: null, basis: `${row.source}: no archived type` };
}

const bases = new Map<string, number>();
for (const { indoor, basis } of classified) {
  const label = `${indoor === null ? "unclassified" : indoor ? "indoor" : "outdoor"}: ${basis}`;
  bases.set(label, (bases.get(label) ?? 0) + 1);
}
for (const [label, count] of [...bases].toSorted(([a], [b]) => a.localeCompare(b))) {
  console.log(`${String(count).padStart(6)}  ${label}`);
}

const unclassified = classified.filter(({ indoor }) => indoor === null);
for (const { row, basis } of unclassified) {
  console.log(
    `unclassified ${row.source}:${row.source_id} (activity ${row.activity_id}): ${basis}`,
  );
}

const indoorActivities = new Set(
  classified.filter(({ indoor }) => indoor === true).map(({ row }) => row.activity_id),
);
console.log(`activities with an indoor source: ${indoorActivities.size}`);

const statements: string[] = [];
for (const source of ["strava", "wahoo"]) {
  for (const indoor of [true, false]) {
    const ids = classified
      .filter((entry) => entry.row.source === source && entry.indoor === indoor)
      .map(({ row }) => literal(row.source_id));
    for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
      statements.push(
        `UPDATE activity_sources SET indoor = ${indoor ? 1 : 0} WHERE indoor IS NULL AND source = '${source}' AND source_id IN (${ids.slice(start, start + IDS_PER_STATEMENT).join(", ")});`,
      );
    }
  }
}
console.log(`statements to run: ${statements.length}`);

if (flags["dry-run"]) {
  console.log("dry run: nothing written");
  process.exit(0);
}

if (statements.length === 0) {
  console.log("nothing to backfill");
  process.exit(0);
}

const sqlPath = "tmp/backfill-indoor.sql";
await Bun.write(sqlPath, statements.join("\n") + "\n");
run(["d1", "execute", DATABASE, "--remote", "--yes", "--file", sqlPath]);

const counts = query(
  "SELECT source, indoor, COUNT(*) AS n FROM activity_sources GROUP BY source, indoor ORDER BY source, indoor",
);
console.log("flags now:", JSON.stringify(counts));

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function query(sql: string): Record<string, unknown>[] {
  const stdout = run(["d1", "execute", DATABASE, "--remote", "--json", "--command", sql]);
  const parsed = JSON.parse(stdout) as { results: Record<string, unknown>[] }[];
  const first = parsed[0];
  if (!first) {
    throw new Error(`no result from d1 execute: ${stdout.slice(0, 200)}`);
  }
  return first.results;
}

function run(args: string[]): string {
  const result = Bun.spawnSync(["bun", "run", "--silent", "wrangler", "--", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed (${result.exitCode})`);
  }
  return result.stdout.toString();
}
