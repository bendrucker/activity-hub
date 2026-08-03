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

// Wahoo events carry the full workout summary, FIT file URL included, so the
// message carries it too and the consumer never calls the Wahoo API.
export interface WahooIngestMessage {
  source: "wahoo";
  kind: "workout_summary";
  workoutId: number;
  summary: WahooWorkoutSummary;
}

export type IngestMessage = StravaIngestMessage | WahooIngestMessage;
