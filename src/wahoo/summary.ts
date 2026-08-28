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

// Wahoo retains no original file for early ELEMNT-era workouts (observed
// through 2017-12): the summary comes back complete but `file` is empty. The
// summary is still the raw record for those rides, so `file` is optional and
// ingest degrades to summary-only.
export interface WahooWorkoutSummary {
  id: number;
  duration_total_accum?: string;
  file?: { url: string } | null;
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
  const fileOk =
    file === undefined || file === null || (isRecord(file) && typeof file.url === "string");
  return (
    fileOk &&
    isRecord(workout) &&
    Number.isInteger(workout.id) &&
    typeof workout.starts === "string" &&
    typeof workout.minutes === "number" &&
    typeof workout.workout_type_id === "number"
  );
}

export function summaryFileUrl(summary: WahooWorkoutSummary): string | null {
  return summary.file?.url ?? null;
}

export interface SyncStub {
  // The app that pushed the workout in, named when we know its id.
  app: string;
  // The workout's id in that app, where the real recording lives.
  foreignId: string;
}

// A device workout's token names the head unit and a counter ("ELEMNT BOLT
// 511E:65"). A workout a third-party app synced in instead carries its
// fitness_app_id and the id it holds there. Wahoo stores those with a null
// summary and answers 401 for one forever, so they are absences by design.
const SYNC_WORKOUT_TOKEN = /^FID(\d+) (\d+):\d+$/;

const FITNESS_APPS: Record<string, string> = { "1085": "strava" };

export function syncStub(workout: Record<string, unknown>): SyncStub | null {
  const { workout_token: token } = workout;
  if (typeof token !== "string") {
    return null;
  }
  const match = SYNC_WORKOUT_TOKEN.exec(token);
  if (match === null) {
    return null;
  }
  const appId = match[1]!;
  return { app: FITNESS_APPS[appId] ?? `app ${appId}`, foreignId: match[2]! };
}

// duration_total_accum is elapsed seconds as a decimal string. minutes is
// rounded, so it is only the fallback.
export function durationS(summary: WahooWorkoutSummary): number {
  const total = Number(summary.duration_total_accum);
  return Number.isFinite(total) && total > 0 ? Math.round(total) : summary.workout.minutes * 60;
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
