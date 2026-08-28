import { MAX_START_DELTA_S } from "./match";
import type { Source, SourceRecord } from "./record";
import type { Sport } from "./sport";
import { parseStartedAt, planMatchOrMint, planSourceUpdate, type Statement } from "./upsert";

export type { Source, SourceRecord };

export interface UpsertResult {
  activityId: string;
  outcome: "existing" | "attached" | "minted";
}

export async function upsertSourceRecord(
  db: D1Database,
  record: SourceRecord,
): Promise<UpsertResult> {
  const existing = await db
    .prepare(
      "SELECT activity_id, raw_keys FROM activity_sources WHERE source = ?1 AND source_id = ?2",
    )
    .bind(record.source, record.sourceId)
    .first<{ activity_id: string; raw_keys: string }>();

  const now = new Date().toISOString();

  if (existing) {
    // The update runs even when it carries no new raw keys: a fresh upsert
    // is a liveness signal, and the statement reverses any soft delete.
    const update = planSourceUpdate(
      record,
      JSON.parse(existing.raw_keys) as Record<string, string>,
      now,
    );
    await prepare(db, update.statement).run();
    return { activityId: existing.activity_id, outcome: "existing" };
  }

  const startedAtMs = parseStartedAt(record);
  const windowStart = new Date(startedAtMs - MAX_START_DELTA_S * 1000).toISOString();
  const windowEnd = new Date(startedAtMs + MAX_START_DELTA_S * 1000).toISOString();

  const { results } = await db
    .prepare(
      `SELECT activity_id, started_at, sport, duration_s
       FROM activities
       WHERE sport = ?1
         AND started_at >= ?2
         AND started_at <= ?3
         AND NOT EXISTS (
           SELECT 1 FROM activity_sources
           WHERE activity_sources.activity_id = activities.activity_id
             AND activity_sources.source = ?4
         )`,
    )
    .bind(record.sport, windowStart, windowEnd, record.source)
    .all<{
      activity_id: string;
      started_at: string;
      sport: Sport;
      duration_s: number;
    }>();

  const plan = planMatchOrMint(
    record,
    results.map((row) => ({
      activityId: row.activity_id,
      startedAt: row.started_at,
      sport: row.sport,
      durationS: row.duration_s,
    })),
    now,
  );
  await db.batch(plan.statements.map((statement) => prepare(db, statement)));
  return { activityId: plan.activity.activityId, outcome: plan.outcome };
}

// Records raw keys for a source already in the registry, for a caller that
// archived bytes without the detail an upsert needs. Answers whether the merge
// wrote anything.
//
// Unlike the upsert path this leaves `deleted_at` alone. A fresh upsert means
// the source is live upstream again and deliberately reverses a soft delete.
// Finding a photo says nothing about whether the activity still exists.
export async function mergeRawKeys(
  db: D1Database,
  source: Source,
  sourceId: string,
  keys: Record<string, string>,
): Promise<boolean> {
  // Both the merge and the did-anything-change test run in SQL. Reading the row
  // first and writing back a merged copy would drop a key another writer added
  // in between, costing a re-fetch of bytes already in R2. The WHERE clause
  // matches no row when the source is absent and none when every key is already
  // recorded, which is the same answer the caller wants in both cases.
  const row = await db
    .prepare(
      `UPDATE activity_sources SET raw_keys = json_patch(raw_keys, ?1), updated_at = ?2
       WHERE source = ?3 AND source_id = ?4
         AND raw_keys != json_patch(raw_keys, ?1)
       RETURNING source_id`,
    )
    .bind(JSON.stringify(keys), new Date().toISOString(), source, sourceId)
    .first<{ source_id: string }>();
  return row !== null;
}

// Moves a source's `updated_at` when what a raw key points at changed but the
// key itself did not. The Strava photo archive records one `photos` entry
// holding a prefix, so a second photo under that prefix leaves `raw_keys`
// byte-identical and `mergeRawKeys` writes nothing. Publish reads the objects
// behind the prefix rather than the key, so the staleness query has to learn
// about the archive some other way.
export async function touchSource(
  db: D1Database,
  source: Source,
  sourceId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE activity_sources SET updated_at = ?1
       WHERE source = ?2 AND source_id = ?3
       RETURNING source_id`,
    )
    .bind(new Date().toISOString(), source, sourceId)
    .first<{ source_id: string }>();
  return row !== null;
}

// Answers with the activity the source belonged to, or null when the source
// was never recorded. A deleted activity drops out of every staleness query,
// so the deletion has to be carried downstream by whoever performed it.
export async function markSourceDeleted(
  db: D1Database,
  source: Source,
  sourceId: string,
): Promise<string | null> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE activity_sources SET deleted_at = ?1, updated_at = ?1
       WHERE source = ?2 AND source_id = ?3
       RETURNING activity_id`,
    )
    .bind(now, source, sourceId)
    .first<{ activity_id: string }>();
  return row?.activity_id ?? null;
}

function prepare(db: D1Database, statement: Statement): D1PreparedStatement {
  return db.prepare(statement.sql).bind(...statement.params);
}
