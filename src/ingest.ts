import type { WahooWorkoutSummary } from "./wahoo/summary";

// Thrown by consumers when the upstream API rate-limits. The queue handler
// backs off for a full budget window instead of the plain retry delay.
export class RateLimitedError extends Error {}

export interface StravaIngestMessage {
  source: "strava";
  kind: "create" | "update" | "delete";
  objectType: "activity" | "athlete";
  objectId: number;
  updates: Record<string, string>;
}

// Wahoo webhook events carry the full workout summary, FIT file URL
// included, so the message carries it too and the consumer never calls the
// Wahoo API.
export interface WahooSummaryMessage {
  source: "wahoo";
  kind: "workout_summary";
  workoutId: number;
  summary: WahooWorkoutSummary;
}

// Backfill discovers workouts through /v1/workouts, whose entries carry no
// usable summary, so the consumer fetches one per message. The list entry
// rides along because the summary endpoint returns the summary alone, while
// ingest needs the workout nested inside it.
export interface WahooWorkoutMessage {
  source: "wahoo";
  kind: "workout";
  workoutId: number;
  workout: Record<string, unknown>;
}

export type WahooIngestMessage = WahooSummaryMessage | WahooWorkoutMessage;

export type IngestMessage = StravaIngestMessage | WahooIngestMessage;
