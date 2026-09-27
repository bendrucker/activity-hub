#!/usr/bin/env bun
// Plans folding each Wahoo-only activity into the Strava-only activity that
// records the same ride.
//
// A pair merges only when each side is the other's best match, so two Wahoo
// recordings sharing a start with one Strava ride leave the loser alone. The
// Wahoo source moves onto the Strava activity, which keeps the Strava id, its
// title, and its URL on the site, and takes Wahoo's start, duration, and
// timezone, the same overwrite an attach makes at ingest. The emptied
// activity stays in the registry: publish reads an activity with no sources as
// the signal to delete its site row. The sweep never selects an activity with
// no sources, so each one needs a publish message of its own.
//
// This only reads. It writes the SQL and the emptied ids to tmp/ for review,
// and applying them is a separate step:
//
//   bun run wrangler d1 execute activity-hub-registry --remote --file tmp/merge-unmatched.sql
//
// Usage: bun scripts/merge-unmatched.ts
import { matchActivity, type MatchCandidate } from "../src/match";
import type { Sport } from "../src/sport";

const DATABASE = "activity-hub-registry";
const SQL_PATH = "tmp/merge-unmatched.sql";
const ORPHANS_PATH = "tmp/merge-unmatched-orphans.json";

interface SingleSourceActivity extends MatchCandidate {
  timezone: string;
  timezoneInferred: number;
  sourceId: string;
}

// Only activities holding exactly one source row, live, are in play. A
// soft-deleted source still owns its slot in the (activity_id, source) index,
// and an activity already holding both sources has nothing to merge.
const rows = query(`
  SELECT a.activity_id, a.started_at, a.sport, a.duration_s, a.timezone, a.timezone_inferred,
         s.source, s.source_id
  FROM activities a
  JOIN activity_sources s USING (activity_id)
  WHERE s.deleted_at IS NULL
    AND a.activity_id IN (
      SELECT activity_id FROM activity_sources GROUP BY activity_id HAVING COUNT(*) = 1
    )
    AND s.source IN ('wahoo', 'strava')
`);

const wahoo: SingleSourceActivity[] = [];
const strava: SingleSourceActivity[] = [];
for (const row of rows) {
  const activity: SingleSourceActivity = {
    activityId: row["activity_id"] as string,
    startedAt: row["started_at"] as string,
    sport: row["sport"] as Sport,
    durationS: row["duration_s"] as number,
    timezone: row["timezone"] as string,
    timezoneInferred: row["timezone_inferred"] as number,
    sourceId: row["source_id"] as string,
  };
  (row["source"] === "wahoo" ? wahoo : strava).push(activity);
}
console.log(`single-source activities: ${wahoo.length} wahoo, ${strava.length} strava`);

const now = new Date().toISOString();
const statements: string[] = [];
const orphans: string[] = [];
let contested = 0;

for (const recording of wahoo) {
  const ride = matchActivity(recording, strava) as SingleSourceActivity | null;
  if (ride === null) {
    continue;
  }
  if (matchActivity(ride, wahoo)?.activityId !== recording.activityId) {
    contested += 1;
    console.log(
      `skip ${recording.activityId}: strava ${ride.sourceId} matches another wahoo recording better`,
    );
    continue;
  }

  console.log(
    `${recording.startedAt} wahoo ${recording.sourceId} (${recording.durationS}s) -> strava ${ride.sourceId} (${ride.durationS}s) ${ride.activityId}`,
  );
  statements.push(
    `UPDATE activity_sources SET activity_id = ${literal(ride.activityId)}, updated_at = ${literal(now)} WHERE source = 'wahoo' AND source_id = ${literal(recording.sourceId)} AND activity_id = ${literal(recording.activityId)};`,
    `UPDATE activities SET started_at = ${literal(recording.startedAt)}, duration_s = ${recording.durationS}, timezone = ${literal(recording.timezone)}, timezone_inferred = ${recording.timezoneInferred}, updated_at = ${literal(now)} WHERE activity_id = ${literal(ride.activityId)};`,
    `UPDATE activities SET updated_at = ${literal(now)} WHERE activity_id = ${literal(recording.activityId)};`,
  );
  orphans.push(recording.activityId);
}

console.log(`merges: ${orphans.length}, contested: ${contested}`);
await Bun.write(SQL_PATH, statements.join("\n") + "\n");
await Bun.write(ORPHANS_PATH, JSON.stringify(orphans, null, 2) + "\n");
console.log(`plan: ${SQL_PATH}, emptied activities: ${ORPHANS_PATH}`);

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
