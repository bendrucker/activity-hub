import type { SourceRecord } from "../record";
import { sportFromWahoo } from "../sport";

// The subset of the workout_summary webhook payload
// (https://cloud-api.wahooligan.com/#webhooks) that ingest reads. Parsed
// events keep the fields this type omits, so the archived summary.json
// stays complete.
export interface WahooWorkout {
  id: number;
  starts: string;
  minutes: number;
  workout_type_id: number;
}

export interface WahooWorkoutSummary {
  id: number;
  duration_total_accum?: string;
  file: { url: string };
  workout: WahooWorkout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWorkoutSummary(
  value: unknown,
): value is WahooWorkoutSummary & Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const { file, workout } = value;
  return (
    isRecord(file) &&
    typeof file.url === "string" &&
    isRecord(workout) &&
    Number.isInteger(workout.id) &&
    typeof workout.starts === "string" &&
    typeof workout.minutes === "number" &&
    typeof workout.workout_type_id === "number"
  );
}

// duration_total_accum is elapsed seconds as a decimal string. minutes is
// rounded, so it is only the fallback.
export function durationS(summary: WahooWorkoutSummary): number {
  const total = Number(summary.duration_total_accum);
  return Number.isFinite(total) && total > 0
    ? Math.round(total)
    : summary.workout.minutes * 60;
}

export interface ResolvedTimezone {
  timezone: string;
  // True when the zone came from a fallback rather than the FIT track.
  inferred: boolean;
}

export function summarySourceRecord(
  summary: WahooWorkoutSummary,
  timezone: ResolvedTimezone,
  rawKeys: Record<string, string>,
): SourceRecord {
  return {
    source: "wahoo",
    sourceId: String(summary.workout.id),
    startedAt: summary.workout.starts,
    timezone: timezone.timezone,
    timezoneInferred: timezone.inferred,
    sport: sportFromWahoo(summary.workout.workout_type_id),
    durationS: durationS(summary),
    rawKeys,
  };
}
