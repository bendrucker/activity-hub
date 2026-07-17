import { ulid } from "ulid";
import { MAX_START_DELTA_S, matchActivity } from "../match";
import type { Source, SourceRecord } from "../record";
import type { Sport } from "../sport";

export interface RegistryActivity {
  activityId: string;
  startedAt: string;
  sport: Sport;
  durationS: number;
}

export interface RegistrySourceRow {
  source: Source;
  sourceId: string;
  activityId: string;
  rawKeys: Record<string, string>;
}

export interface RegistryState {
  activities: RegistryActivity[];
  sources: RegistrySourceRow[];
}

export type DeltaOutcome = "unchanged" | "updated" | "attached" | "minted";

export interface DeltaRecordResult {
  sourceId: string;
  activityId: string;
  outcome: DeltaOutcome;
}

export interface Delta {
  statements: string[];
  results: DeltaRecordResult[];
}

// Batch counterpart of upsertSourceRecord: the same match-or-mint rules run
// against an in-memory snapshot of the registry, emitting a SQL delta instead
// of executing per-row queries. Re-running over unchanged state emits no
// statements. The statements are not applied transactionally, but an
// interruption self-heals: an activities row orphaned by a missed source
// INSERT is an exact match candidate on the next run, which attaches to it.
export function buildDelta(
  state: RegistryState,
  records: readonly SourceRecord[],
  now: string,
): Delta {
  const sources = new Map(
    state.sources.map((row) => [`${row.source}:${row.sourceId}`, row]),
  );
  const sourced = new Map<string, Set<Source>>();
  const markSourced = (activityId: string, source: Source): void => {
    let set = sourced.get(activityId);
    if (!set) {
      set = new Set();
      sourced.set(activityId, set);
    }
    set.add(source);
  };
  for (const row of state.sources) {
    markSourced(row.activityId, row.source);
  }
  const activities = [...state.activities];
  const startTimes = new Map(
    activities.map((activity) => [
      activity.activityId,
      Date.parse(activity.startedAt),
    ]),
  );

  const statements: string[] = [];
  const results: DeltaRecordResult[] = [];

  for (const record of records) {
    // The attach branch below only touches updated_at. Attaching a Wahoo
    // record must also overwrite started_at, duration_s, and timezone with
    // the device telemetry (see upsertSourceRecord), which is unimplemented
    // here, so anything but Strava is refused rather than written wrong.
    if (record.source !== "strava") {
      throw new Error(`unsupported import source ${record.source}`);
    }

    const existing = sources.get(`${record.source}:${record.sourceId}`);
    if (existing) {
      const unchanged = Object.entries(record.rawKeys).every(
        ([key, value]) => existing.rawKeys[key] === value,
      );
      if (unchanged) {
        results.push({
          sourceId: record.sourceId,
          activityId: existing.activityId,
          outcome: "unchanged",
        });
        continue;
      }
      const merged = { ...existing.rawKeys, ...record.rawKeys };
      statements.push(
        `UPDATE activity_sources SET raw_keys = ${text(JSON.stringify(merged))}, updated_at = ${text(now)} WHERE source = ${text(record.source)} AND source_id = ${text(record.sourceId)};`,
      );
      existing.rawKeys = merged;
      results.push({
        sourceId: record.sourceId,
        activityId: existing.activityId,
        outcome: "updated",
      });
      continue;
    }

    const startedAtMs = Date.parse(record.startedAt);
    if (Number.isNaN(startedAtMs)) {
      throw new Error(
        `unparseable startedAt ${JSON.stringify(record.startedAt)} for ${record.source}:${record.sourceId}`,
      );
    }
    const startedAt = new Date(startedAtMs).toISOString();

    const candidates = activities.filter(
      (activity) =>
        activity.sport === record.sport &&
        Math.abs((startTimes.get(activity.activityId) ?? NaN) - startedAtMs) <=
          MAX_START_DELTA_S * 1000 &&
        !sourced.get(activity.activityId)?.has(record.source),
    );
    const match = matchActivity(
      { startedAt, sport: record.sport, durationS: record.durationS },
      candidates,
    );

    const activityId = match?.activityId ?? ulid(startedAtMs);
    if (match) {
      statements.push(
        insertSource(record, activityId, now),
        `UPDATE activities SET updated_at = ${text(now)} WHERE activity_id = ${text(activityId)};`,
      );
    } else {
      statements.push(
        `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES (${values(activityId, startedAt, record.timezone, record.sport, record.durationS, now, now)});`,
        insertSource(record, activityId, now),
      );
      activities.push({
        activityId,
        startedAt,
        sport: record.sport,
        durationS: record.durationS,
      });
      startTimes.set(activityId, startedAtMs);
    }

    markSourced(activityId, record.source);
    sources.set(`${record.source}:${record.sourceId}`, {
      source: record.source,
      sourceId: record.sourceId,
      activityId,
      rawKeys: record.rawKeys,
    });

    results.push({
      sourceId: record.sourceId,
      activityId,
      outcome: match ? "attached" : "minted",
    });
  }

  return { statements, results };
}

function insertSource(
  record: SourceRecord,
  activityId: string,
  now: string,
): string {
  return `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES (${values(record.source, record.sourceId, activityId, JSON.stringify(record.rawKeys), now, now)});`;
}

function values(...items: (string | number)[]): string {
  return items
    .map((item) => (typeof item === "number" ? String(item) : text(item)))
    .join(", ");
}

function text(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
