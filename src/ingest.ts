// Thrown by consumers when the upstream API rate-limits. The queue handler
// backs off for a full budget window instead of the plain retry delay.
export class RateLimitedError extends Error {}

export interface IngestMessage {
  source: "strava";
  kind: "create" | "update" | "delete";
  objectType: "activity" | "athlete";
  objectId: number;
  updates: Record<string, string>;
}
