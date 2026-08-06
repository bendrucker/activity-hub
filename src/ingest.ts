import type { WahooWorkoutSummary } from "./wahoo/summary";

// Thrown by consumers when the upstream API rate-limits. The queue handler
// backs off for a full budget window instead of the plain retry delay.
export class RateLimitedError extends Error {
  constructor(
    message: string,
    // Seconds the source asked us to wait, when it said. Beats guessing at
    // which of its nested budget windows the 429 came from.
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export function retryAfterS(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) {
    return undefined;
  }
  // The header is either delta-seconds or an HTTP date.
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds));
  }
  const at = Date.parse(header);
  return Number.isNaN(at)
    ? undefined
    : Math.max(0, Math.round((at - Date.now()) / 1000));
}

// Strava webhook payloads carry ids only, plus the field names that changed
// on an update, so the consumer fetches the activity itself.
export interface StravaWebhookMessage {
  source: "strava";
  kind: "create" | "update" | "delete";
  objectType: "activity" | "athlete";
  objectId: number;
  updates: Record<string, string>;
}

// Titles and photos land after upload, and an edit that never produced a
// webhook is otherwise never revisited. Reconciliation sweeps the activities
// it already holds and the consumer writes only what actually differs.
export interface StravaRefreshMessage {
  source: "strava";
  kind: "refresh";
  objectId: number;
}

export type StravaIngestMessage = StravaWebhookMessage | StravaRefreshMessage;

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

// Queues caps a batch at 100 messages, so a page-sized sweep sends one
// subrequest per chunk instead of one per message.
const QUEUE_BATCH_LIMIT = 100;

export async function sendBatched<T>(
  queue: Queue<T>,
  messages: T[],
): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += QUEUE_BATCH_LIMIT) {
    const chunk = messages.slice(offset, offset + QUEUE_BATCH_LIMIT);
    await queue.sendBatch(chunk.map((body) => ({ body })));
  }
}
