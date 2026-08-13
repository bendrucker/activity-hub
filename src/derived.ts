export type Stage = "decode" | "lake" | "publish";

export type DerivedStatus = "ok" | "failed" | "skipped";

export const STAGES: readonly Stage[] = ["decode", "lake", "publish"];

// A row only reaches `failed` after the queue has exhausted its own retries,
// so every attempt counted here is a whole separate delivery. Five rides out a
// transient upstream outage while keeping a genuinely undecodable activity out
// of the backlog instead of re-selecting it on every drain.
export const MAX_ATTEMPTS = 5;

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
// candidate that turns out to be current is caught by isCurrent.
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
  WHERE derived.activity_id IS NULL
     OR live.source_updated_at > derived.updated_at
     OR (derived.status = 'failed' AND derived.attempts < ?2)
  ORDER BY live.source_updated_at, live.activity_id
  LIMIT ?3`;

export async function staleActivities(
  db: D1Database,
  stage: Stage,
  limit: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(STALE)
    .bind(stage, MAX_ATTEMPTS, limit)
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
         AND input_fingerprint = ?3`,
    )
    .bind(activityId, stage, fingerprint)
    .first<{ current: number }>();
  return row !== null;
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
         status, attempts, error, updated_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (activity_id, stage) DO UPDATE SET
         input_fingerprint = excluded.input_fingerprint,
         output_key = excluded.output_key,
         status = excluded.status,
         -- The budget bounds retries against one input, so it belongs to the
         -- fingerprint it accrued against. A run that got somewhere hands it
         -- back, and new bytes start it over: a row that parked on the old
         -- input would otherwise get one try at the new one, since its own
         -- failure stamps the newest updated_at and STALE stops selecting it.
         attempts = CASE
           WHEN excluded.status <> 'failed' THEN 0
           WHEN derived.input_fingerprint = excluded.input_fingerprint
             THEN derived.attempts + 1
           ELSE 1
         END,
         error = excluded.error,
         updated_at = excluded.updated_at`,
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
  }>(STAGES.map((stage) => db.prepare(STALE).bind(stage, MAX_ATTEMPTS, 1)));

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
    oldestStale: STAGES.flatMap((stage, index) => {
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
