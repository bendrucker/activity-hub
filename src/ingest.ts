export interface IngestMessage {
  source: "strava";
  kind: "create" | "update" | "delete";
  objectType: "activity" | "athlete";
  objectId: number;
  updates: Record<string, string>;
}
