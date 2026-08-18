import { MAX_START_DELTA_S } from "./match";
import type { Source, SourceRecord } from "./record";
import type { Sport } from "./sport";
import {
  parseStartedAt,
  planMatchOrMint,
  planSourceUpdate,
  type Statement,
} from "./upsert";

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
  const windowStart = new Date(
    startedAtMs - MAX_START_DELTA_S * 1000,
  ).toISOString();
  const windowEnd = new Date(
    startedAtMs + MAX_START_DELTA_S * 1000,
  ).toISOString();

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
