#!/usr/bin/env bun
// Backfills activities.timezone_inferred for rows imported before migration
// 0003 added the column. Inferredness is re-derived from the export archive
// exactly as the importer resolves it: an activity whose GPS track resolved a
// zone got a real timezone, everything else (no file, no track, virtual
// course GPS, parse failure) was inferred. Only inferred rows need an UPDATE
// since the column defaults to 0.
//
// Usage: bun scripts/backfill-timezone-inferred.ts <export-dir> [--dry-run]
import path from "node:path";
import { parseArgs } from "node:util";
import { parseActivitiesCsv } from "../src/import/csv";
import { trackTimezone } from "../src/import/timezone";
import { extractTrack } from "../src/import/track";

const DATABASE = "activity-hub-registry";

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const exportDir = positionals[0];
if (!exportDir) {
  console.error(
    "usage: bun scripts/backfill-timezone-inferred.ts <export-dir> [--dry-run]",
  );
  process.exit(1);
}

const activities = parseActivitiesCsv(
  await Bun.file(path.join(exportDir, "activities.csv")).text(),
);
console.log(`${activities.length} activities in activities.csv`);

const resolved = new Set<string>();
let processed = 0;
for (const activity of activities) {
  if (
    activity.filename &&
    (await Bun.file(path.join(exportDir, activity.filename)).exists())
  ) {
    try {
      const bytes = await Bun.file(
        path.join(exportDir, activity.filename),
      ).bytes();
      const points = await extractTrack(bytes, activity.filename);
      if (trackTimezone(points, activity.sportType) !== null) {
        resolved.add(activity.sourceId);
      }
    } catch {
      // The importer treated a parse failure as trackless, so the zone it
      // wrote was inferred. Leaving the ID unresolved matches that.
    }
  }
  processed += 1;
  if (processed % 500 === 0) {
    console.log(`parsed ${processed}/${activities.length}`);
  }
}
console.log(`zones resolved from GPS: ${resolved.size}`);

const rows = query(
  "SELECT source_id, activity_id FROM activity_sources WHERE source = 'strava'",
);
const activityIds = new Map(
  rows.map((row) => [row["source_id"] as string, row["activity_id"] as string]),
);

const statements = activities.flatMap((activity) => {
  const activityId = activityIds.get(activity.sourceId);
  if (!activityId || resolved.has(activity.sourceId)) {
    return [];
  }
  return [
    `UPDATE activities SET timezone_inferred = 1 WHERE activity_id = '${activityId}';`,
  ];
});
console.log(`inferred rows to flag: ${statements.length}`);

if (flags["dry-run"]) {
  console.log("dry run: nothing written");
  process.exit(0);
}

if (statements.length === 0) {
  console.log("nothing to backfill");
  process.exit(0);
}

const sqlPath = "tmp/backfill-timezone-inferred.sql";
await Bun.write(sqlPath, statements.join("\n") + "\n");
run(["d1", "execute", DATABASE, "--remote", "--yes", "--file", sqlPath]);

const counts = query(
  "SELECT COUNT(*) AS flagged FROM activities WHERE timezone_inferred = 1",
);
console.log("flagged now:", JSON.stringify(counts[0]));

function query(sql: string): Record<string, unknown>[] {
  const stdout = run([
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(stdout) as { results: Record<string, unknown>[] }[];
  const first = parsed[0];
  if (!first) {
    throw new Error(`no result from d1 execute: ${stdout.slice(0, 200)}`);
  }
  return first.results;
}

function run(args: string[]): string {
  const result = Bun.spawnSync(
    ["bun", "run", "--silent", "wrangler", "--", ...args],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed (${result.exitCode})`);
  }
  return result.stdout.toString();
}
