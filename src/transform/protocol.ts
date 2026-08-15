// The container's wire contract, imported by both the Worker consumer and the
// container itself so the shape exists once. Nothing here imports anything: the
// container builds without the Workers runtime types, so a binding type
// reaching this file would break its typecheck.

// The columns the container writes into each activity's Parquet. Raw bytes and
// their etags say nothing about the code that read them, so a decoder that
// gains a column leaves every existing artifact short of it and the lake build
// fails on a table it cannot bind. Bumping this changes every decode
// fingerprint, which is what re-decodes the corpus.
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

// The lake build is corpus-wide, so its request names locations rather than
// activities. Every field is a URI the container hands to DuckDB directly.
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
