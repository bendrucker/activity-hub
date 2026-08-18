// The container's wire contract, imported by both the Worker consumer and the
// container itself so the shape exists once. Nothing here imports anything: the
// container builds without the Workers runtime types, so a binding type
// reaching this file would break its typecheck.

// The columns the container writes into each activity's Parquet. A decoder
// that gains a column leaves every existing artifact short of it and the lake
// build fails on a table it cannot bind, so bumping this is what re-decodes
// the corpus. See ARTIFACT_VERSION in src/derived.ts for how a bump reaches
// the sweep.
export const DECODE_SCHEMA_VERSION = 2;

export interface DecodeWork {
  activityId: string;
  // Raw R2 object keys for this activity, in the order they should be tried.
  // The consumer reads them from activity_sources.raw_keys.
  rawKeys: string[];
}

export interface DecodeRequest {
  work: DecodeWork[];
}

export type DecodeOutcome =
  | {
      activityId: string;
      status: "ok";
      // R2 key prefix of the Parquet artifacts the container wrote.
      outputKey: string;
      // Which raw key actually produced the rows. The lake stage reads
      // telemetry provenance off this, and nothing else records the choice.
      rawKey: string;
      records: number;
      laps: number;
      sessions: number;
      // Non-fatal decode errors, carried through from TelemetryActivity.
      errors: string[];
    }
  | {
      activityId: string;
      status: "failed";
      error: string;
    }
  | {
      activityId: string;
      status: "skipped";
      // Why there was nothing to do: no decodable raw key, for instance.
      reason: string;
    };

export interface DecodeResponse {
  outcomes: DecodeOutcome[];
}

// The lake build is corpus-wide, so its request names locations. Every field is
// a URI the container hands to DuckDB directly.
export interface LakeRequest {
  // Prefix under which the decode stage wrote one directory per activity.
  decode: string;
  // The registry snapshot the Worker exported from D1 for this run.
  registry: string;
  // The archived Strava bulk export's activities.csv, or null when none is
  // archived, in which case every Strava column comes out null.
  stravaExport: string | null;
  // Prefix the rebuilt tables are written under.
  output: string;
}

export interface LakeTableResult {
  name: string;
  rows: number;
}

export interface LakeResponse {
  outputKey: string;
  tables: LakeTableResult[];
}

// The shape of what the publish stage sends the website. A change here means
// every published row is one version behind what the site should be holding,
// which is what makes the sweep republish the corpus.
export const PUBLISH_SCHEMA_VERSION = 2;

export interface PublishWork {
  activityId: string;
  // Prefix holding this activity's decode Parquet files.
  decode: string;
}

export interface PublishRequest {
  work: PublishWork;
}

export interface PowerBest {
  durationS: number;
  watts: number;
}

export type PowerSource = "measured" | "estimated" | "none";

// Everything in the feed row that only the telemetry can answer. The Worker
// supplies the registry fields, because a Worker cannot read Parquet and the
// container cannot read D1.
export interface PublishArtifact {
  // Encoded polyline, decimated to every tenth point.
  polyline: string | null;
  // 100 altitudes in metres, evenly spaced by distance rather than by time.
  elevationProfile: number[] | null;
  averageWatts: number | null;
  powerSource: PowerSource;
  bests: PowerBest[];
  // What the recording device totalled for the ride, null where it recorded
  // nothing. The lake's activities table prefers these over the provider's
  // numbers, and the feed row follows the same order.
  distanceM: number | null;
  elevationM: number | null;
  movingS: number | null;
}

export type PublishOutcome =
  | {
      activityId: string;
      status: "ok";
      artifact: PublishArtifact;
    }
  | {
      activityId: string;
      status: "failed";
      error: string;
    }
  | {
      activityId: string;
      status: "skipped";
      reason: string;
    };

export interface PublishResponse {
  outcome: PublishOutcome;
}
