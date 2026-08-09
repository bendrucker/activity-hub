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
