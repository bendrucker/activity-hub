import { sendBatched, type IngestMessage } from "../ingest";

// A refresh costs up to three Strava reads against a 1,000/day budget, so a
// run that enqueued the whole gap at once would spend the day's budget in the
// queue and park the tail. The caller walks the gap by looping on nextCursor.
export const PER_RUN = 100;

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

  const messages: IngestMessage[] = results.map((row) => ({
    source: "strava",
    kind: "refresh",
    objectId: Number(row.source_id),
  }));
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

  const messages: IngestMessage[] = results.map((row) => ({
    source: "strava",
    kind: "refresh",
    objectId: Number(row.source_id),
  }));
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

export interface ListedPhotoBackfillResult {
  enqueued: number;
  skipped: number;
  remaining: number;
}

// An activity with no photos never gains a `photos` key, so it never leaves the
// population above and the cursor walk re-reads it on every future run. The
// bulk export's Media column says which activities have photos, so a caller
// holding it can name them and skip the rest: against the 2026-07-16 export
// that was 2,631 of 4,016 rows never worth a Strava read.
//
// The named ids are still filtered through UNPHOTOGRAPHED, so re-sending a page
// that already landed costs one query rather than a Strava read per activity.
export async function backfillListedStravaPhotos(
  env: Env,
  ids: readonly string[],
): Promise<ListedPhotoBackfillResult> {
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
  const { results } = await env.REGISTRY.prepare(
    `SELECT source_id ${UNPHOTOGRAPHED} AND source_id IN (${placeholders}) ORDER BY source_id`,
  )
    .bind(...ids)
    .all<{ source_id: string }>();

  const messages: IngestMessage[] = results.map((row) => ({
    source: "strava",
    kind: "refresh",
    objectId: Number(row.source_id),
  }));
  await sendBatched(env.INGEST_QUEUE, messages);

  return {
    enqueued: messages.length,
    // Anything the caller named that this did not enqueue: already archived,
    // soft-deleted, or not a Strava row at all. A page that is entirely skipped
    // is how a re-run reports itself.
    skipped: ids.length - messages.length,
    remaining: await countUnphotographed(env.REGISTRY),
  };
}
