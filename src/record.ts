import type { Sport } from "./sport";

export type Source = "strava" | "wahoo";

export interface SourceRecord {
  source: Source;
  sourceId: string;
  startedAt: string;
  timezone: string;
  sport: Sport;
  durationS: number;
  rawKeys: Record<string, string>;
}
