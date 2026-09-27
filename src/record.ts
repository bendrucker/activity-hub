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
  // Whether the source's own type says the activity happened indoors.
  indoor: boolean;
  durationS: number;
  rawKeys: Record<string, string>;
}
