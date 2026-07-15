import { ulid } from "ulid";
import { MAX_START_DELTA_S, matchActivity } from "./match";
import type { Sport } from "./sport";

export type Source = "strava" | "wahoo";

export interface SourceRecord {
  source: Source;
  sourceId: string;
  startedAt: string;
  timezone: string;
  sport: Sport;
  durationS: number;
  rawKeys: Record<string, string>;
}

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
    const rawKeys: Record<string, string> = {
      ...JSON.parse(existing.raw_keys),
      ...record.rawKeys,
    };
    await db
      .prepare(
        "UPDATE activity_sources SET raw_keys = ?1, updated_at = ?2 WHERE source = ?3 AND source_id = ?4",
      )
      .bind(JSON.stringify(rawKeys), now, record.source, record.sourceId)
      .run();
    return { activityId: existing.activity_id, outcome: "existing" };
  }

  const startedAtMs = Date.parse(record.startedAt);
  if (Number.isNaN(startedAtMs)) {
    throw new Error(
      `unparseable startedAt ${JSON.stringify(record.startedAt)} for ${record.source}:${record.sourceId}`,
    );
  }
  const startedAt = new Date(startedAtMs).toISOString();
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

  const match = matchActivity(
    { startedAt, sport: record.sport, durationS: record.durationS },
    results.map((row) => ({
      activityId: row.activity_id,
      startedAt: row.started_at,
      sport: row.sport,
      durationS: row.duration_s,
    })),
  );

  if (match) {
    // Wahoo carries the device telemetry, so its start, duration, and
    // timezone overwrite whatever the earlier source recorded.
    let updateActivity: D1PreparedStatement;
    if (record.source === "wahoo") {
      updateActivity = db
        .prepare(
          "UPDATE activities SET started_at = ?1, duration_s = ?2, timezone = ?3, updated_at = ?4 WHERE activity_id = ?5",
        )
        .bind(
          startedAt,
          record.durationS,
          record.timezone,
          now,
          match.activityId,
        );
    } else {
      updateActivity = db
        .prepare("UPDATE activities SET updated_at = ?1 WHERE activity_id = ?2")
        .bind(now, match.activityId);
    }
    await db.batch([
      insertSource(db, record, match.activityId, now),
      updateActivity,
    ]);
    return { activityId: match.activityId, outcome: "attached" };
  }

  const activityId = ulid(startedAtMs);
  await db.batch([
    db
      .prepare(
        "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      )
      .bind(
        activityId,
        startedAt,
        record.timezone,
        record.sport,
        record.durationS,
        now,
      ),
    insertSource(db, record, activityId, now),
  ]);
  return { activityId, outcome: "minted" };
}

function insertSource(
  db: D1Database,
  record: SourceRecord,
  activityId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(
      record.source,
      record.sourceId,
      activityId,
      JSON.stringify(record.rawKeys),
      now,
    );
}
