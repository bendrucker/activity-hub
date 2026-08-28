#!/usr/bin/env bun
// Fills activities.name from the Strava bulk export. Titles reach the site
// through the publish stage, which reads them off the archived detail.json,
// and only a few hundred activities ever had one archived. The export carries
// a title for every activity it covers, so this is the only route to a titled
// feed that costs no API calls.
//
// Newer activities are not in the export. Their detail.json arrives with the
// webhook and wins over this column anyway.
//
// Usage: bun scripts/backfill-activity-name.ts <export-dir> [--dry-run]
import path from "node:path";
import { parseArgs } from "node:util";
import { parseActivitiesCsv } from "../src/import/csv";

const DATABASE = "activity-hub-registry";

// D1 rejects an oversized script, and one statement per activity across a
// four-thousand-row corpus comfortably exceeds it.
const BATCH = 1000;

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const exportDir = positionals[0];
if (!exportDir) {
  console.error("usage: bun scripts/backfill-activity-name.ts <export-dir> [--dry-run]");
  process.exit(1);
}

const activities = parseActivitiesCsv(
  await Bun.file(path.join(exportDir, "activities.csv")).text(),
);
console.log(`${activities.length} activities in activities.csv`);

const rows = query(
  "SELECT source_id, activity_id FROM activity_sources WHERE source = 'strava' AND deleted_at IS NULL",
);
const activityIds = new Map(
  rows.map((row) => [row["source_id"] as string, row["activity_id"] as string]),
);

let unmatched = 0;
let untitled = 0;
const statements = activities.flatMap((activity) => {
  const activityId = activityIds.get(activity.sourceId);
  if (activityId === undefined) {
    unmatched += 1;
    return [];
  }
  if (activity.name === null) {
    untitled += 1;
    return [];
  }
  return [
    `UPDATE activities SET name = ${literal(activity.name)} WHERE activity_id = ${literal(activityId)};`,
  ];
});

console.log(`names to write: ${statements.length}`);
console.log(`not in the registry: ${unmatched}, blank in the export: ${untitled}`);

if (flags["dry-run"]) {
  console.log("dry run: nothing written");
  process.exit(0);
}

if (statements.length === 0) {
  console.log("nothing to backfill");
  process.exit(0);
}

for (let start = 0; start < statements.length; start += BATCH) {
  const batch = statements.slice(start, start + BATCH);
  const sqlPath = `tmp/backfill-activity-name-${String(start)}.sql`;
  await Bun.write(sqlPath, batch.join("\n") + "\n");
  run(["d1", "execute", DATABASE, "--remote", "--yes", "--file", sqlPath]);
  console.log(`wrote ${String(start + batch.length)}/${statements.length}`);
}

const counts = query("SELECT COUNT(*) AS named FROM activities WHERE name IS NOT NULL");
console.log("named now:", JSON.stringify(counts[0]));

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
