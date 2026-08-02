import type { Sport } from "./sport";

export type Source = "strava" | "wahoo";

export interface SourceRecord {
  source: Source;
  sourceId: string;
  startedAt: string;
  timezone: string;
  // True when the zone is a guess (nearest-in-time neighbor or a fixed
  // fallback) rather than resolved from the activity's own data.
  timezoneInferred: boolean;
  sport: Sport;
  durationS: number;
  rawKeys: Record<string, string>;
}
