import { sendBatched, type IngestMessage } from "../ingest";

// A refresh costs up to three Strava reads against a 1,000/day budget, so a
// run that enqueued the whole gap at once would spend the day's budget in the
// queue and park the tail. The caller walks the gap by looping on nextCursor.
export const PER_RUN = 100;

function ingestMessages(
  kind: "refresh" | "photos",
  rows: readonly { source_id: string }[],
): IngestMessage[] {
  return rows.map((row) => ({
    source: "strava",
    kind,
    objectId: Number(row.source_id),
  }));
}

export interface StravaBackfillOptions {
  cursor?: string;
  perRun?: number;
}

export interface StravaBackfillResult {
  enqueued: number;
  remaining: number;
  done: boolean;
  nextCursor?: string;
}

// The bulk export supplies `original` and the webhook path supplies `streams`.
// A row carrying neither has no archived bytes at all, which is the whole
// population this walks.
const UNARCHIVED = `
  FROM activity_sources
  WHERE source = 'strava'
    AND deleted_at IS NULL
    AND json_extract(raw_keys, '$.original') IS NULL
    AND json_extract(raw_keys, '$.streams') IS NULL`;

export async function backfillStravaStreams(
  env: Env,
  options: StravaBackfillOptions = {},
): Promise<StravaBackfillResult> {
  const perRun = options.perRun ?? PER_RUN;
  // Keyset rather than OFFSET: the queue fills raw_keys asynchronously, so
  // rows leave this result set while the walk is still running and an offset
  // would step over the ones that shifted down.
  const cursor = options.cursor ?? "";

  const { results } = await env.REGISTRY.prepare(
    `SELECT source_id ${UNARCHIVED} AND source_id > ?1 ORDER BY source_id LIMIT ?2`,
  )
    .bind(cursor, perRun)
    .all<{ source_id: string }>();

  const messages = ingestMessages("refresh", results);
  await sendBatched(env.INGEST_QUEUE, messages);

  const remaining = await countUnarchived(env.REGISTRY);
  const last = results.at(-1)?.source_id;
  const done = results.length < perRun;

  return {
    enqueued: messages.length,
    remaining,
    done,
    ...(done || last === undefined ? {} : { nextCursor: last }),
  };
}

async function countUnarchived(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n ${UNARCHIVED}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Photos arrive under two key shapes: the webhook path records a single
// `photos` entry holding a prefix, and the bulk import records a
// `photos/<name>` entry per file. An activity with neither has no archived
// photo, which is not the same as having none to archive.
const UNPHOTOGRAPHED = `
  FROM activity_sources
  WHERE source = 'strava'
    AND deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM json_each(activity_sources.raw_keys) AS entry
      WHERE entry.key = 'photos' OR entry.key LIKE 'photos/%'
    )`;

// A refresh re-reads the detail and runs syncPhotos, which is the only code
// that knows how to list and download Strava's photos. The photo listing is an
// undocumented endpoint and every activity swept costs a call against it, so
// this walks in pages the caller drives rather than enqueuing the whole gap.
export async function backfillStravaPhotos(
  env: Env,
  options: StravaBackfillOptions = {},
): Promise<StravaBackfillResult> {
  const perRun = options.perRun ?? PER_RUN;
  const cursor = options.cursor ?? "";

  const { results } = await env.REGISTRY.prepare(
    `SELECT source_id ${UNPHOTOGRAPHED} AND source_id > ?1 ORDER BY source_id LIMIT ?2`,
  )
    .bind(cursor, perRun)
    .all<{ source_id: string }>();

  const messages = ingestMessages("refresh", results);
  await sendBatched(env.INGEST_QUEUE, messages);

  const remaining = await countUnphotographed(env.REGISTRY);
  const last = results.at(-1)?.source_id;
  const done = results.length < perRun;

  return {
    enqueued: messages.length,
    remaining,
    done,
    ...(done || last === undefined ? {} : { nextCursor: last }),
  };
}

async function countUnphotographed(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n ${UNPHOTOGRAPHED}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface ListedPhotoBackfillResult extends StravaBackfillResult {
  skipped: number;
}

// An activity with no photos never gains a `photos` key, so it never leaves
// UNPHOTOGRAPHED and the cursor walk re-reads it on every future run. The bulk
// export's Media column says which activities have photos, so a caller holding
// it can name them and skip the rest: against the 2026-07-16 export that was
// 2,631 of 4,016 rows never worth a Strava read.
//
// The named ids are still filtered through UNPHOTOGRAPHED, so an id archived by
// an earlier page costs one query rather than a Strava read. An id that
// refreshed to zero photos gained no key, so it stays selectable and a resend
// does spend a read on it.
export async function backfillListedStravaPhotos(
  env: Env,
  ids: readonly string[],
): Promise<ListedPhotoBackfillResult> {
  // Deduped before the query because `IN` matches a repeated id once, which
  // would leave skipped counting a difference the caller never asked for.
  const named = [...new Set(ids)];
  const placeholders = named.map((_, index) => `?${index + 1}`).join(", ");
  const { results } = await env.REGISTRY.prepare(
    `SELECT source_id ${UNPHOTOGRAPHED} AND source_id IN (${placeholders}) ORDER BY source_id`,
  )
    .bind(...named)
    .all<{ source_id: string }>();

  const messages = ingestMessages("refresh", results);
  const [, remaining] = await Promise.all([
    sendBatched(env.INGEST_QUEUE, messages),
    countUnphotographed(env.REGISTRY),
  ]);

  return {
    enqueued: messages.length,
    // Anything the caller named that this did not enqueue: already archived,
    // soft-deleted, or not a Strava row at all. A page that is entirely skipped
    // is how a re-run reports itself.
    skipped: named.length - messages.length,
    remaining,
    // The caller's list is the whole run, so there is no next page to ask for.
    done: true,
  };
}

// Matches the fourth entry in wrangler.jsonc's crons. The scheduled handler
// serves every trigger and tells them apart by this expression, so the two have
// to stay in step.
//
// Ten activities an hour is 240 Strava reads a day against a 1,000/day budget,
// and ten reads in an hour stay far under the binding window of 100 per fifteen
// minutes, so a new ride's webhook is never stuck behind the backfill in the
// ingest queue. At that rate the export-derived target list drains in about six
// days. :15 keeps it clear of the :30 transform sweep and the :00 dailies.
export const PHOTO_CRON = "15 * * * *";
export const PHOTO_DRAIN = 10;

export interface PhotoTargetSeed {
  added: number;
  alreadyPresent: number;
  pending: number;
}

// The target list comes from the bulk export's Media column, which the worker
// never sees, so it is handed over rather than derived. Seeding spends no
// Strava read: the cost is entirely in the draining.
export async function seedPhotoBackfillTargets(
  env: Env,
  ids: readonly string[],
): Promise<PhotoTargetSeed> {
  const named = [...new Set(ids)];
  const now = new Date().toISOString();

  const before = await countPhotoTargets(env.REGISTRY);
  await env.REGISTRY.batch(
    named.map((id) =>
      env.REGISTRY.prepare(
        "INSERT OR IGNORE INTO photo_backfill_targets (source_id, added_at) VALUES (?1, ?2)",
      ).bind(id, now),
    ),
  );
  const pending = await countPhotoTargets(env.REGISTRY);

  const added = pending - before;
  return { added, alreadyPresent: named.length - added, pending };
}

export interface PhotoDrainResult {
  enqueued: number;
  dropped: number;
  pending: number;
}

// Progress is this table draining to zero rather than the UNPHOTOGRAPHED count.
// An activity with no photos gains no key, so it never leaves that set.
//
// A target is spent on the way out of the table rather than on the way back
// from a successful consume. The queue retries fifty times into a dead letter
// queue and reseeding from the export costs nothing, so a target lost to a
// failed consume is cheaper than tracking per-id completion.
export async function drainPhotoBackfillTargets(
  env: Env,
): Promise<PhotoDrainResult> {
  const { results: taken } = await env.REGISTRY.prepare(
    "SELECT source_id FROM photo_backfill_targets ORDER BY source_id LIMIT ?1",
  )
    .bind(PHOTO_DRAIN)
    .all<{ source_id: string }>();
  if (taken.length === 0) {
    return { enqueued: 0, dropped: 0, pending: 0 };
  }

  // An id that gained photos through the webhook path or an earlier manual page
  // is dropped here, which costs a query rather than a Strava read.
  const ids = taken.map((row) => row.source_id);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
  const { results } = await env.REGISTRY.prepare(
    `SELECT source_id ${UNPHOTOGRAPHED} AND source_id IN (${placeholders}) ORDER BY source_id`,
  )
    .bind(...ids)
    .all<{ source_id: string }>();

  const messages = ingestMessages("photos", results);
  await sendBatched(env.INGEST_QUEUE, messages);

  // After the send, so a failed enqueue costs a repeated run rather than ten
  // activities silently dropped from the job.
  await env.REGISTRY.prepare(
    `DELETE FROM photo_backfill_targets WHERE source_id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();

  return {
    enqueued: messages.length,
    dropped: ids.length - messages.length,
    pending: await countPhotoTargets(env.REGISTRY),
  };
}

async function countPhotoTargets(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM photo_backfill_targets")
    .first<{ n: number }>();
  return row?.n ?? 0;
}
