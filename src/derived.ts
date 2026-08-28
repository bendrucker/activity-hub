import { DECODE_SCHEMA_VERSION, PUBLISH_SCHEMA_VERSION } from "./transform/protocol";

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
export async function activityRawKeys(db: D1Database, activityId: string): Promise<string[]> {
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

// The queue hands over a whole batch at once, so asking per activity spends a
// subrequest per message where one IN covers all of them. Every id asked for
// comes back, mapped to an empty list when nothing is archived, so the caller
// tells "no rows" apart from "not asked".
export async function activityRawKeysFor(
  db: D1Database,
  activityIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byActivity = new Map<string, string[]>(activityIds.map((id) => [id, []]));
  if (activityIds.length === 0) {
    return byActivity;
  }

  const placeholders = activityIds.map((_, index) => `?${index + 1}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT activity_id, json_extract(raw_keys, '$.original') AS raw_key
       FROM activity_sources
       WHERE activity_id IN (${placeholders})
         AND deleted_at IS NULL
         AND json_extract(raw_keys, '$.original') IS NOT NULL
       ORDER BY activity_id, raw_key`,
    )
    .bind(...activityIds)
    .all<{ activity_id: string; raw_key: string }>();

  for (const row of results) {
    byActivity.get(row.activity_id)?.push(row.raw_key);
  }
  return byActivity;
}

// An upstream edit rewrites the raw object, which changes its etag, which
// changes this digest. Every stage downstream is then stale by definition
// without anything having to observe the edit.
export async function inputFingerprint(bucket: R2Bucket, keys: readonly string[]): Promise<string> {
  if (keys.length === 0) {
    return EMPTY_FINGERPRINT;
  }

  const sorted = [...new Set(keys)].toSorted();
  const objects = await Promise.all(sorted.map((key) => bucket.head(key)));
  // A deleted object contributes a marker rather than dropping out, so losing
  // the bytes is a fingerprint change and not a silent match.
  const payload = sorted
    .map((key, index) => `${key}:${objects[index]?.etag ?? MISSING_OBJECT}`)
    .join("\n");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Candidate selection cannot afford a fingerprint, which costs an R2 head per
// key. This narrows thousands of activities to the ones worth hashing. A
// candidate that turns out to be current is caught by `currentFingerprints`.
// The artifact
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
  const { results } = await staleStatement(db, stage, limit).all<{ activity_id: string }>();
  return results.map((row) => row.activity_id);
}

// One round trip for every stage the sweep asks about, which is all of them on
// the same tick. The selections are independent: enqueueing writes nothing to
// `derived`, so no stage's query can see another's, and the cross-stage
// ordering that keeps publish stale after decode reruns lives in STALE's own
// upstream join rather than in the order these run.
export async function staleActivitiesByStage(
  db: D1Database,
  stages: readonly Stage[],
  limit: number,
): Promise<Map<Stage, string[]>> {
  if (stages.length === 0) {
    return new Map();
  }
  const batched = await db.batch<{ activity_id: string }>(
    stages.map((stage) => staleStatement(db, stage, limit)),
  );
  return new Map(
    stages.map((stage, index) => [
      stage,
      (batched[index]?.results ?? []).map((row) => row.activity_id),
    ]),
  );
}

function staleStatement(db: D1Database, stage: Stage, limit: number): D1PreparedStatement {
  return db
    .prepare(STALE)
    .bind(stage, MAX_ATTEMPTS, limit, ARTIFACT_VERSION[stage], upstreamStage(stage));
}

// The fingerprint a stage last recorded as ok, per activity, for the artifact
// version the code writes today. An activity absent from the answer has no
// current row and is work. Reading them together is what lets the drain ask
// once for a whole queue batch.
export async function currentFingerprints(
  db: D1Database,
  stage: Stage,
  activityIds: readonly string[],
): Promise<Map<string, string>> {
  if (activityIds.length === 0) {
    return new Map();
  }

  const placeholders = activityIds.map((_, index) => `?${index + 3}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT activity_id, input_fingerprint
       FROM derived
       WHERE stage = ?1
         AND artifact_version = ?2
         AND status = 'ok'
         AND activity_id IN (${placeholders})`,
    )
    .bind(stage, ARTIFACT_VERSION[stage], ...activityIds)
    .all<{ activity_id: string; input_fingerprint: string }>();

  return new Map(results.map((row) => [row.activity_id, row.input_fingerprint]));
}

export interface StageRow {
  status: DerivedStatus;
  outputKey: string | null;
  inputFingerprint: string;
  artifactVersion: number;
  attempts: number;
}

// What an upstream stage last recorded, for every activity a drain is about to
// ask about. A stage that reads another's output learns the location from the
// row that recorded it, so the two cannot drift apart, and takes its own
// fingerprint from the same row because that artifact is its input.
//
// The status and attempt count come back with it because a missing artifact
// has two meanings. A stage that ran and gave up will never produce one, and a
// stage that has not run yet still might. A reader that saw only the `ok` rows
// would have to ask a second time to tell them apart. An activity absent from
// the answer has no row for the stage at all.
export async function stageRows(
  db: D1Database,
  stage: Stage,
  activityIds: readonly string[],
): Promise<Map<string, StageRow>> {
  if (activityIds.length === 0) {
    return new Map();
  }

  const placeholders = activityIds.map((_, index) => `?${index + 2}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT activity_id, status, output_key, input_fingerprint, artifact_version, attempts
       FROM derived
       WHERE stage = ?1 AND activity_id IN (${placeholders})`,
    )
    .bind(stage, ...activityIds)
    .all<{
      activity_id: string;
      status: DerivedStatus;
      output_key: string | null;
      input_fingerprint: string;
      artifact_version: number;
      attempts: number;
    }>();

  return new Map(
    results.map((row) => [
      row.activity_id,
      {
        status: row.status,
        outputKey: row.output_key,
        inputFingerprint: row.input_fingerprint,
        artifactVersion: row.artifact_version,
        attempts: row.attempts,
      },
    ]),
  );
}

export interface DerivedOutcome {
  activityId: string;
  stage: Stage;
  inputFingerprint: string;
  status: DerivedStatus;
  outputKey?: string;
  error?: string;
}

export async function recordOutcome(db: D1Database, outcome: DerivedOutcome): Promise<void> {
  await outcomeStatement(db, outcome).run();
}

// D1 runs a batch as one implicit transaction, so recording a queue batch
// this way is all-or-nothing rather than row-by-row. The upsert is idempotent
// and the caller retries the whole batch, so a replay lands the same rows.
export async function recordOutcomes(
  db: D1Database,
  outcomes: readonly DerivedOutcome[],
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }
  await db.batch(outcomes.map((outcome) => outcomeStatement(db, outcome)));
}

function outcomeStatement(db: D1Database, outcome: DerivedOutcome): D1PreparedStatement {
  const failed = outcome.status === "failed";
  return db
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
    );
}

// One batch rather than one statement per activity, for the same reason the
// recording side batches: a queue batch of thirty otherwise spends thirty
// subrequests stamping rows nobody is waiting on.
export async function touchDerivedAll(
  db: D1Database,
  stage: Stage,
  activityIds: readonly string[],
): Promise<void> {
  if (activityIds.length === 0) {
    return;
  }
  const stamped = new Date().toISOString();
  try {
    await db.batch(
      activityIds.map((activityId) =>
        db
          .prepare(
            `UPDATE derived SET updated_at = ?3
             WHERE activity_id = ?1 AND stage = ?2 AND status = 'ok'`,
          )
          .bind(activityId, stage, stamped),
      ),
    );
  } catch (error) {
    console.warn(`failed to stamp ${stage} for ${activityIds.length}: ${String(error)}`);
  }
}

export async function clearDerived(
  db: D1Database,
  activityId: string,
  stage?: Stage,
): Promise<void> {
  const statement =
    stage === undefined
      ? db.prepare("DELETE FROM derived WHERE activity_id = ?1").bind(activityId)
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
      db.prepare(STALE).bind(stage, MAX_ATTEMPTS, 1, ARTIFACT_VERSION[stage], upstreamStage(stage)),
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
