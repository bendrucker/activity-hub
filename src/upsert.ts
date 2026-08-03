import { ulid } from "ulid";
import { matchActivity, type MatchCandidate } from "./match";
import type { SourceRecord } from "./record";

// Owns the column lists, statement shapes, and match-or-mint rules for
// activities and activity_sources. Consumers decide how to execute a
// Statement: the worker binds it as a prepared statement, the importer
// renders it to SQL text.
export interface Statement {
  sql: string;
  params: (string | number)[];
}

export interface SourceUpdate {
  changed: boolean;
  rawKeys: Record<string, string>;
  statement: Statement;
}

export function planSourceUpdate(
  record: SourceRecord,
  existingRawKeys: Record<string, string>,
  now: string,
): SourceUpdate {
  const changed = !Object.entries(record.rawKeys).every(
    ([key, value]) => existingRawKeys[key] === value,
  );
  const rawKeys = { ...existingRawKeys, ...record.rawKeys };
  return {
    changed,
    rawKeys,
    statement: {
      // A fresh upsert means the source is live upstream again, so it also
      // reverses any earlier soft delete.
      sql: "UPDATE activity_sources SET raw_keys = ?1, updated_at = ?2, deleted_at = NULL WHERE source = ?3 AND source_id = ?4",
      params: [JSON.stringify(rawKeys), now, record.source, record.sourceId],
    },
  };
}

export interface MatchOrMint {
  outcome: "attached" | "minted";
  // The activity row as it stands once the statements run, so batch callers
  // can keep in-memory state in step.
  activity: MatchCandidate;
  statements: Statement[];
}

export function planMatchOrMint(
  record: SourceRecord,
  candidates: readonly MatchCandidate[],
  now: string,
): MatchOrMint {
  const startedAtMs = parseStartedAt(record);
  const startedAt = new Date(startedAtMs).toISOString();

  const match = matchActivity(
    { startedAt, sport: record.sport, durationS: record.durationS },
    candidates,
  );

  if (match) {
    // Wahoo carries the device telemetry, so its start, duration, and
    // timezone overwrite whatever the earlier source recorded.
    const wahoo = record.source === "wahoo";
    const updateActivity: Statement = wahoo
      ? {
          sql: "UPDATE activities SET started_at = ?1, duration_s = ?2, timezone = ?3, updated_at = ?4 WHERE activity_id = ?5",
          params: [
            startedAt,
            record.durationS,
            record.timezone,
            now,
            match.activityId,
          ],
        }
      : {
          sql: "UPDATE activities SET updated_at = ?1 WHERE activity_id = ?2",
          params: [now, match.activityId],
        };
    return {
      outcome: "attached",
      activity: wahoo
        ? { ...match, startedAt, durationS: record.durationS }
        : match,
      statements: [insertSource(record, match.activityId, now), updateActivity],
    };
  }

  const activityId = ulid(startedAtMs);
  return {
    outcome: "minted",
    activity: {
      activityId,
      startedAt,
      sport: record.sport,
      durationS: record.durationS,
    },
    statements: [
      {
        sql: "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params: [
          activityId,
          startedAt,
          record.timezone,
          record.sport,
          record.durationS,
          now,
        ],
      },
      insertSource(record, activityId, now),
    ],
  };
}

export function parseStartedAt(record: SourceRecord): number {
  const startedAtMs = Date.parse(record.startedAt);
  if (Number.isNaN(startedAtMs)) {
    throw new Error(
      `unparseable startedAt ${JSON.stringify(record.startedAt)} for ${record.source}:${record.sourceId}`,
    );
  }
  return startedAtMs;
}

function insertSource(
  record: SourceRecord,
  activityId: string,
  now: string,
): Statement {
  return {
    sql: "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    params: [
      record.source,
      record.sourceId,
      activityId,
      JSON.stringify(record.rawKeys),
      now,
    ],
  };
}
