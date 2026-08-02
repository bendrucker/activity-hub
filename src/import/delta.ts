import { MAX_START_DELTA_S } from "../match";
import type { Source, SourceRecord } from "../record";
import type { Sport } from "../sport";
import {
  parseStartedAt,
  planMatchOrMint,
  planSourceUpdate,
  type Statement,
} from "../upsert";

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
    const existing = sources.get(`${record.source}:${record.sourceId}`);
    if (existing) {
      const update = planSourceUpdate(record, existing.rawKeys, now);
      // Unlike the worker upsert, an unchanged record emits nothing, so the
      // delta stays empty when re-run over its own output.
      if (!update.changed) {
        results.push({
          sourceId: record.sourceId,
          activityId: existing.activityId,
          outcome: "unchanged",
        });
        continue;
      }
      statements.push(render(update.statement));
      existing.rawKeys = update.rawKeys;
      results.push({
        sourceId: record.sourceId,
        activityId: existing.activityId,
        outcome: "updated",
      });
      continue;
    }

    const startedAtMs = parseStartedAt(record);

    // A superset prefilter for performance only: the time window bounds the
    // scan cheaply, matchActivity applies the real rules (sport, duration).
    const candidates = activities.filter(
      (activity) =>
        Math.abs((startTimes.get(activity.activityId) ?? NaN) - startedAtMs) <=
          MAX_START_DELTA_S * 1000 &&
        !sourced.get(activity.activityId)?.has(record.source),
    );
    const plan = planMatchOrMint(record, candidates, now);

    for (const statement of plan.statements) {
      statements.push(render(statement));
    }
    if (plan.outcome === "minted") {
      activities.push(plan.activity);
    } else {
      // A Wahoo attach overwrites the matched activity's telemetry, so the
      // in-memory row must follow for later records to match against.
      activities[
        activities.findIndex(
          (activity) => activity.activityId === plan.activity.activityId,
        )
      ] = plan.activity;
    }
    startTimes.set(
      plan.activity.activityId,
      Date.parse(plan.activity.startedAt),
    );

    markSourced(plan.activity.activityId, record.source);
    sources.set(`${record.source}:${record.sourceId}`, {
      source: record.source,
      sourceId: record.sourceId,
      activityId: plan.activity.activityId,
      rawKeys: record.rawKeys,
    });

    results.push({
      sourceId: record.sourceId,
      activityId: plan.activity.activityId,
      outcome: plan.outcome,
    });
  }

  return { statements, results };
}

// The delta is applied as a SQL file, so bound parameters are inlined as
// escaped literals.
function render(statement: Statement): string {
  return (
    statement.sql.replace(/\?(\d+)/g, (placeholder, index: string) => {
      const param = statement.params[Number(index) - 1];
      if (param === undefined) {
        throw new Error(`missing parameter ${placeholder}: ${statement.sql}`);
      }
      return typeof param === "number" ? String(param) : text(param);
    }) + ";"
  );
}

function text(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
