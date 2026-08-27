import {
  DECODE_SCHEMA_VERSION,
  PUBLISH_SCHEMA_VERSION,
} from "./transform/protocol";

export type Stage = "decode" | "lake" | "publish";

export type DerivedStatus = "ok" | "failed" | "skipped";

export const STAGES: readonly Stage[] = ["decode", "lake", "publish"];

// The stages the sweep enqueues, which is also the set the staleness query
// answers for. `lake` keeps no per-activity row by design, so asking it for its
// oldest stale activity returns the whole registry and reads as a backlog
// rather than as a stage that has no per-activity grain.
export const SWEPT_STAGES: readonly Stage[] = ["decode", "publish"];

// A stage reads another stage's output, so the upstream running again leaves
// it stale even when nothing about the source changed. Without this a decode
// schema bump would re-decode the whole corpus and republish none of it, and
// one sweep could enqueue decode and publish for the same activity in the same
// batch with publish reading the previous artifact.
export const STAGE_DEPENDS_ON: Partial<Record<Stage, Stage>> = {
  publish: "decode",
};

// A row only reaches `failed` after the queue has exhausted its own retries,
// so every attempt counted here is a whole separate delivery. Five rides out a
// transient upstream outage while keeping a genuinely undecodable activity out
// of the backlog instead of re-selecting it on every drain.
export const MAX_ATTEMPTS = 5;

// The shape of what a stage writes, which its inputs say nothing about. Raw
// bytes and their etags describe the input alone, and nothing describes the
// code that read them. Every row carries the version that produced it, so
// bumping one makes every row that stage already wrote stale and the sweep
// runs them again. Rows written before the column existed carry 0, which no
// stage claims.
export const ARTIFACT_VERSION: Record<Stage, number> = {
  decode: DECODE_SCHEMA_VERSION,
  lake: 1,
  publish: PUBLISH_SCHEMA_VERSION,
};

// A fingerprint is a SHA-256 hex digest, so neither sentinel can collide with
// one.
export const EMPTY_FINGERPRINT = "empty";
const MISSING_OBJECT = "absent";

// Only `original` holds decodable telemetry bytes: `summary` and `detail` are
// provider JSON and `streams` is Strava's resampled view of the same ride.
export async function activityRawKeys(
  db: D1Database,
  activityId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT json_extract(raw_keys, '$.original') AS raw_key
       FROM activity_sources
       WHERE activity_id = ?1
         AND deleted_at IS NULL
         AND json_extract(raw_keys, '$.original') IS NOT NULL
       ORDER BY raw_key`,
    )
    .bind(activityId)
    .all<{ raw_key: string }>();
  return results.map((row) => row.raw_key);
}

// An upstream edit rewrites the raw object, which changes its etag, which
// changes this digest. Every stage downstream is then stale by definition
// without anything having to observe the edit.
export async function inputFingerprint(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<string> {
  if (keys.length === 0) {
    return EMPTY_FINGERPRINT;
  }

  const sorted = [...new Set(keys)].sort();
  const objects = await Promise.all(sorted.map((key) => bucket.head(key)));
  // A deleted object contributes a marker rather than dropping out, so losing
  // the bytes is a fingerprint change and not a silent match.
  const payload = sorted
    .map((key, index) => `${key}:${objects[index]?.etag ?? MISSING_OBJECT}`)
    .join("\n");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Candidate selection cannot afford a fingerprint, which costs an R2 head per
// key. This narrows thousands of activities to the ones worth hashing. A
// candidate that turns out to be current is caught by isCurrent. The artifact
// version is the one input SQL can compare on its own, and it has to be
// compared here: a stage whose output shape changed leaves every source row's
// updated_at exactly where it was, so nothing else would ever select it.
const STALE = `
  WITH live AS (
    SELECT activity_id, MAX(updated_at) AS source_updated_at
    FROM activity_sources
    WHERE deleted_at IS NULL
    GROUP BY activity_id
  )
  SELECT live.activity_id AS activity_id,
         live.source_updated_at AS source_updated_at
  FROM live
  LEFT JOIN derived
    ON derived.activity_id = live.activity_id AND derived.stage = ?1
  LEFT JOIN derived AS upstream
    ON upstream.activity_id = live.activity_id AND upstream.stage = ?5
  WHERE derived.activity_id IS NULL
     OR live.source_updated_at > derived.updated_at
     OR derived.artifact_version <> ?4
     OR (derived.status = 'failed' AND derived.attempts < ?2)
     OR (upstream.updated_at IS NOT NULL AND upstream.updated_at > derived.updated_at)
  ORDER BY live.source_updated_at, live.activity_id
  LIMIT ?3`;

// A stage with no upstream joins to its own row, where the comparison is a row
// against itself and the clause can never fire.
function upstreamStage(stage: Stage): Stage {
  return STAGE_DEPENDS_ON[stage] ?? stage;
}

export async function staleActivities(
  db: D1Database,
  stage: Stage,
  limit: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(STALE)
    .bind(
      stage,
      MAX_ATTEMPTS,
      limit,
      ARTIFACT_VERSION[stage],
      upstreamStage(stage),
    )
    .all<{ activity_id: string; source_updated_at: string }>();
  return results.map((row) => row.activity_id);
}

export async function isCurrent(
  db: D1Database,
  activityId: string,
  stage: Stage,
  fingerprint: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS current
       FROM derived
       WHERE activity_id = ?1
         AND stage = ?2
         AND status = 'ok'
         AND input_fingerprint = ?3
         AND artifact_version = ?4`,
    )
    .bind(activityId, stage, fingerprint, ARTIFACT_VERSION[stage])
    .first<{ current: number }>();
  return row !== null;
}

export interface StageRow {
  status: DerivedStatus;
  outputKey: string | null;
  inputFingerprint: string;
  artifactVersion: number;
  attempts: number;
}

// What an upstream stage last recorded. A stage that reads another's output
// learns the location from the row that recorded it, so the two cannot drift
// apart, and takes its own fingerprint from the same row because that
// artifact is its input.
//
// The status and attempt count come back with it because a missing artifact
// has two meanings. A stage that ran and gave up will never produce one, and a
// stage that has not run yet still might. A reader that saw only the `ok` rows
// would have to ask a second time to tell them apart.
export async function stageRow(
  db: D1Database,
  activityId: string,
  stage: Stage,
): Promise<StageRow | null> {
  const row = await db
    .prepare(
      `SELECT status, output_key, input_fingerprint, artifact_version, attempts
       FROM derived
       WHERE activity_id = ?1 AND stage = ?2`,
    )
    .bind(activityId, stage)
    .first<{
      status: DerivedStatus;
      output_key: string | null;
      input_fingerprint: string;
      artifact_version: number;
      attempts: number;
    }>();
  return row === null
    ? null
    : {
        status: row.status,
        outputKey: row.output_key,
        inputFingerprint: row.input_fingerprint,
        artifactVersion: row.artifact_version,
        attempts: row.attempts,
      };
}

export interface DerivedOutcome {
  activityId: string;
  stage: Stage;
  inputFingerprint: string;
  status: DerivedStatus;
  outputKey?: string;
  error?: string;
}

export async function recordOutcome(
  db: D1Database,
  outcome: DerivedOutcome,
): Promise<void> {
  const failed = outcome.status === "failed";
  await db
    .prepare(
      `INSERT INTO derived (
         activity_id, stage, input_fingerprint, output_key,
         status, attempts, error, updated_at, artifact_version
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (activity_id, stage) DO UPDATE SET
         input_fingerprint = excluded.input_fingerprint,
         output_key = excluded.output_key,
         status = excluded.status,
         -- The budget bounds retries against one input, so it belongs to the
         -- fingerprint and artifact version it accrued against. A run that got
         -- somewhere hands it back, and either a new input or a new decoder
         -- starts it over: a row that parked on the old pair would otherwise
         -- get one try at the new one, since its own failure stamps the newest
         -- updated_at and STALE stops selecting it.
         attempts = CASE
           WHEN excluded.status <> 'failed' THEN 0
           WHEN derived.input_fingerprint = excluded.input_fingerprint
             AND derived.artifact_version = excluded.artifact_version
             THEN derived.attempts + 1
           ELSE 1
         END,
         error = excluded.error,
         updated_at = excluded.updated_at,
         artifact_version = excluded.artifact_version`,
    )
    .bind(
      outcome.activityId,
      outcome.stage,
      outcome.inputFingerprint,
      outcome.outputKey ?? null,
      outcome.status,
      failed ? 1 : 0,
      outcome.error ?? null,
      new Date().toISOString(),
      ARTIFACT_VERSION[outcome.stage],
    )
    .run();
}

export async function clearDerived(
  db: D1Database,
  activityId: string,
  stage?: Stage,
): Promise<void> {
  const statement =
    stage === undefined
      ? db
          .prepare("DELETE FROM derived WHERE activity_id = ?1")
          .bind(activityId)
      : db
          .prepare("DELETE FROM derived WHERE activity_id = ?1 AND stage = ?2")
          .bind(activityId, stage);
  await statement.run();
}

const RECENT_FAILURES = 20;

export interface StageStatusCount {
  stage: Stage;
  status: DerivedStatus;
  count: number;
}

export interface OldestStale {
  stage: Stage;
  activityId: string;
  sourceUpdatedAt: string;
}

export interface DerivedFailure {
  activityId: string;
  stage: Stage;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

// A row at the attempt ceiling is invisible to STALE, so it never appears as
// stale and nothing will pick it up again. Counting those separately is what
// distinguishes a failure the next sweep retries from one that needs
// /admin/transform to move.
export interface StageParked {
  stage: Stage;
  count: number;
}

export interface PipelineReport {
  counts: StageStatusCount[];
  oldestStale: OldestStale[];
  parked: StageParked[];
  failures: DerivedFailure[];
}

export async function pipelineReport(db: D1Database): Promise<PipelineReport> {
  const counts = await db
    .prepare(
      `SELECT stage, status, COUNT(*) AS count
       FROM derived
       GROUP BY stage, status
       ORDER BY stage, status`,
    )
    .all<{ stage: Stage; status: DerivedStatus; count: number }>();

  const oldest = await db.batch<{
    activity_id: string;
    source_updated_at: string;
  }>(
    SWEPT_STAGES.map((stage) =>
      db
        .prepare(STALE)
        .bind(
          stage,
          MAX_ATTEMPTS,
          1,
          ARTIFACT_VERSION[stage],
          upstreamStage(stage),
        ),
    ),
  );

  const parked = await db
    .prepare(
      `SELECT stage, COUNT(*) AS count
       FROM derived
       WHERE status = 'failed' AND attempts >= ?1
       GROUP BY stage
       ORDER BY stage`,
    )
    .bind(MAX_ATTEMPTS)
    .all<{ stage: Stage; count: number }>();

  const failures = await db
    .prepare(
      `SELECT activity_id, stage, error, attempts, updated_at
       FROM derived
       WHERE status = 'failed'
       ORDER BY updated_at DESC
       LIMIT ?1`,
    )
    .bind(RECENT_FAILURES)
    .all<{
      activity_id: string;
      stage: Stage;
      error: string | null;
      attempts: number;
      updated_at: string;
    }>();

  return {
    counts: counts.results,
    oldestStale: SWEPT_STAGES.flatMap((stage, index) => {
      const row = oldest[index]?.results[0];
      return row === undefined
        ? []
        : [
            {
              stage,
              activityId: row.activity_id,
              sourceUpdatedAt: row.source_updated_at,
            },
          ];
    }),
    parked: parked.results,
    failures: failures.results.map((row) => ({
      activityId: row.activity_id,
      stage: row.stage,
      error: row.error,
      attempts: row.attempts,
      updatedAt: row.updated_at,
    })),
  };
}
