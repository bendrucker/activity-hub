import { appendFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseActivitiesCsv, type ExportActivity } from "../src/import/csv";
import {
  buildDelta,
  type RegistryActivity,
  type RegistrySourceRow,
  type RegistryState,
} from "../src/import/delta";
import { placeActivity, toSourceRecord } from "../src/import/placement";
import { inferTimezones, trackTimezone } from "../src/import/timezone";
import {
  extractTrack,
  polylineDocument,
  type PolylineDocument,
} from "../src/import/track";
import type { SourceRecord } from "../src/record";

const BUCKET = "activity-hub-raw";
const DATABASE = "activity-hub-registry";
const S3_ENDPOINT =
  "https://72bdc77341dc52a3cf4a94097f9ad96f.r2.cloudflarestorage.com";
// The Cloudflare API allows 1,200 requests per 5 minutes. Eight workers
// putting small objects exceed it and draw 429s, so the fallback stays
// under ~3 puts/second.
const UPLOAD_CONCURRENCY = 4;
// Last resort when no activity in the export resolved a zone. Home base.
const FALLBACK_TIMEZONE = "America/Los_Angeles";

interface ParseFailure {
  sourceId: string;
  filename: string;
  error: string;
}

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    staging: { type: "string", default: "tmp/staging" },
  },
  allowPositionals: true,
});

const exportDir = positionals[0];
if (!exportDir) {
  console.error(
    "usage: bun run import -- <export-dir> [--dry-run] [--staging <dir>]",
  );
  process.exit(1);
}

const activities = parseActivitiesCsv(
  await Bun.file(path.join(exportDir, "activities.csv")).text(),
);
console.log(`${activities.length} activities in activities.csv`);

const mediaAvailable = new Set<string>(
  (await readdir(path.join(exportDir, "media")).catch(() => [])).map(
    (name) => `media/${name}`,
  ),
);

const polylines = new Map<string, PolylineDocument>();
const failures: ParseFailure[] = [];
const placements = new Map<string, ReturnType<typeof placeActivity>>();
const resolvedTimezones = new Map<string, string>();

let processed = 0;
for (let activity of activities) {
  if (
    activity.filename &&
    !(await Bun.file(path.join(exportDir, activity.filename)).exists())
  ) {
    // A CSV row can reference a file absent from the archive. Treat the
    // activity as file-less so staging and raw_keys stay consistent with
    // what actually exists.
    failures.push({
      sourceId: activity.sourceId,
      filename: activity.filename,
      error: "missing from archive",
    });
    activity = { ...activity, filename: null };
  }

  const placement = placeActivity(activity, mediaAvailable);
  placements.set(activity.sourceId, placement);

  if (activity.filename) {
    try {
      const bytes = await Bun.file(
        path.join(exportDir, activity.filename),
      ).bytes();
      const points = await extractTrack(bytes, activity.filename);
      if (points.length > 0) {
        polylines.set(activity.sourceId, polylineDocument(points));
        // Virtual rides carry in-game course GPS (Zwift's Watopia sits in
        // the Solomon Islands), which says nothing about where the athlete
        // was. Leave the zone unresolved so it is inferred from neighbors.
        if (!activity.sportType.startsWith("Virtual")) {
          const timezone = trackTimezone(points);
          if (timezone !== null) {
            resolvedTimezones.set(activity.sourceId, timezone);
          }
        }
      }
    } catch (error) {
      failures.push({
        sourceId: activity.sourceId,
        filename: activity.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  processed += 1;
  if (processed % 500 === 0) {
    console.log(`parsed ${processed}/${activities.length}`);
  }
}

const timezones = inferTimezones(
  activities.map((activity) => ({
    startedAt: activity.startedAt,
    timezone: resolvedTimezones.get(activity.sourceId) ?? null,
  })),
  FALLBACK_TIMEZONE,
);
const records: SourceRecord[] = activities.map((activity, index) =>
  toSourceRecord(
    activity,
    timezones[index] ?? FALLBACK_TIMEZONE,
    placements.get(activity.sourceId)?.rawKeys ?? {},
  ),
);

console.log("reading registry state");
const state = readRegistryState();
const now = new Date().toISOString();
const delta = buildDelta(state, records, now);

report(activities, polylines, failures, delta);

if (flags["dry-run"]) {
  console.log("dry run: nothing written");
  process.exit(0);
}

const staging = flags.staging;
const objectsDir = path.join(staging, "objects");
console.log(`building staging tree in ${staging}`);

// A previous run may have staged objects this export no longer produces.
// Wiping first keeps the upload set equal to what this run staged.
await rm(objectsDir, { recursive: true, force: true });

let objectCount = 0;
for (const activity of activities) {
  const placement = placements.get(activity.sourceId);
  if (!placement) {
    continue;
  }
  for (const object of placement.objects) {
    await Bun.write(
      path.join(objectsDir, object.key),
      Bun.file(path.join(exportDir, object.sourcePath)),
    );
    objectCount += 1;
  }
  const polyline = polylines.get(activity.sourceId);
  if (polyline) {
    await Bun.write(
      path.join(objectsDir, placement.polylineKey),
      JSON.stringify(polyline),
    );
    objectCount += 1;
  }
}
console.log(`staged ${objectCount} objects`);

const sqlPath = path.join(staging, "registry.sql");
await Bun.write(sqlPath, delta.statements.join("\n") + "\n");

await upload(objectsDir);

if (delta.statements.length > 0) {
  console.log(`applying ${delta.statements.length} registry statements`);
  run(["d1", "execute", DATABASE, "--remote", "--yes", "--file", sqlPath]);
} else {
  console.log("registry delta empty: nothing to apply");
}

const counts = query(
  "SELECT (SELECT COUNT(*) FROM activities) AS activities, (SELECT COUNT(*) FROM activity_sources) AS sources",
);
console.log("registry now:", JSON.stringify(counts[0]));

function report(
  activities: ExportActivity[],
  polylines: Map<string, PolylineDocument>,
  failures: ParseFailure[],
  delta: ReturnType<typeof buildDelta>,
): void {
  const bySport = new Map<string, number>();
  const byExtension = new Map<string, number>();
  let noFile = 0;
  for (const activity of activities) {
    bySport.set(activity.sportType, (bySport.get(activity.sportType) ?? 0) + 1);
    if (activity.filename) {
      const dot = activity.filename.indexOf(".");
      const extension = dot === -1 ? "(none)" : activity.filename.slice(dot);
      byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
    } else {
      noFile += 1;
    }
  }
  const outcomes = new Map<string, number>();
  for (const result of delta.results) {
    outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
  }

  console.log(`\nrecords: ${delta.results.length}`);
  console.log("by sport:", Object.fromEntries(bySport));
  console.log("by extension:", Object.fromEntries(byExtension));
  console.log(`no file: ${noFile}`);
  console.log(`tracks extracted: ${polylines.size}`);
  // inferTimezones only reaches the fallback when no activity resolved a
  // zone, so the unresolved count is entirely one bucket or the other.
  if (resolvedTimezones.size > 0) {
    console.log(
      `timezone inferred from nearest GPS activity: ${activities.length - resolvedTimezones.size}`,
    );
  } else {
    console.log(
      `no GPS activity resolved a zone: all ${activities.length} fell back to ${FALLBACK_TIMEZONE}`,
    );
  }
  console.log(`parse failures: ${failures.length}`);
  for (const failure of failures) {
    console.log(`  ${failure.sourceId} ${failure.filename}: ${failure.error}`);
  }
  console.log("outcomes:", Object.fromEntries(outcomes));
  console.log(`sql statements: ${delta.statements.length}\n`);
}

function readRegistryState(): RegistryState {
  const activities = query(
    "SELECT activity_id, started_at, sport, duration_s FROM activities",
  ).map((row): RegistryActivity => ({
    activityId: row["activity_id"] as string,
    startedAt: row["started_at"] as string,
    sport: row["sport"] as RegistryActivity["sport"],
    durationS: row["duration_s"] as number,
  }));
  const sources = query(
    "SELECT source, source_id, activity_id, raw_keys FROM activity_sources",
  ).map((row): RegistrySourceRow => ({
    source: row["source"] as RegistrySourceRow["source"],
    sourceId: row["source_id"] as string,
    activityId: row["activity_id"] as string,
    rawKeys: JSON.parse(row["raw_keys"] as string) as Record<string, string>,
  }));
  return { activities, sources };
}

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

async function upload(objectsDir: string): Promise<void> {
  if (
    process.env["AWS_ACCESS_KEY_ID"] &&
    process.env["AWS_SECRET_ACCESS_KEY"]
  ) {
    console.log("uploading with aws s3 sync");
    const result = Bun.spawnSync(
      [
        "aws",
        "s3",
        "sync",
        `${objectsDir}/`,
        `s3://${BUCKET}/`,
        "--endpoint-url",
        S3_ENDPOINT,
        "--checksum-algorithm",
        "CRC32",
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.exitCode !== 0) {
      throw new Error(`aws s3 sync failed (${result.exitCode})`);
    }
    return;
  }

  console.log(
    "no R2 S3 token in env: falling back to wrangler r2 object put (slow)",
  );
  // Uploads are logged next to the objects dir as key + content hash so an
  // interrupted run resumes where it left off, while a re-run that staged
  // different bytes for a key uploads it again. Failures are collected, not
  // fatal: with thousands of puts, one flaky request must not abandon the
  // rest.
  const doneLog = `${objectsDir}.uploaded`;
  const done = new Set(
    (
      await Bun.file(doneLog)
        .text()
        .catch(() => "")
    ) //
      .split("\n")
      .filter(Boolean),
  );
  const staged = (
    await readdir(objectsDir, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(objectsDir, path.join(entry.parentPath, entry.name)),
    );
  const files: { entry: string; stamp: string }[] = [];
  for (const entry of staged) {
    const bytes = await Bun.file(path.join(objectsDir, entry)).bytes();
    const stamp = `${entry}\t${Bun.hash(bytes).toString(16)}`;
    if (!done.has(stamp)) {
      files.push({ entry, stamp });
    }
  }
  let uploaded = 0;
  const failures: string[] = [];
  const queue = [...files];
  const workers = Array.from(
    { length: UPLOAD_CONCURRENCY },
    async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item) {
          return;
        }
        const key = item.entry.split(path.sep).join("/");
        const started = Date.now();
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            "--silent",
            "wrangler",
            "--",
            "r2",
            "object",
            "put",
            `${BUCKET}/${key}`,
            "--file",
            path.join(objectsDir, item.entry),
            "--remote",
          ],
          { stdio: ["ignore", "ignore", "inherit"] },
        );
        const code = await proc.exited;
        const elapsed = Date.now() - started;
        if (elapsed < 1400) {
          await Bun.sleep(1400 - elapsed);
        }
        if (code === 0) {
          appendFileSync(doneLog, item.stamp + "\n");
          uploaded += 1;
        } else {
          failures.push(key);
          console.error(`failed: ${key} (${code})`);
        }
        if ((uploaded + failures.length) % 100 === 0) {
          console.log(
            `uploaded ${uploaded}/${files.length} (${failures.length} failed)`,
          );
        }
      }
    },
  );
  await Promise.all(workers);
  console.log(`uploaded ${uploaded}/${files.length}`);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} uploads failed; re-run to retry (successes are skipped via ${doneLog})`,
    );
  }
}
