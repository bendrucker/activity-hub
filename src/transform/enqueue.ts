import {
  clearDerived,
  staleActivities,
  SWEPT_STAGES,
  type Stage,
} from "../derived";
import type { TransformMessage } from "./consume";

// Cloudflare caps a batch send at 100 messages.
const SEND_BATCH = 100;

// Per stage, per run. The sweep is idempotent and ordered oldest-first, so a
// backlog larger than this drains over consecutive runs rather than needing a
// cursor. Reprocessing something specific goes through enqueueActivity instead
// of waiting for the sweep to reach it.
export const RECONCILE_LIMIT = 1000;

// Matches the third entry in wrangler.jsonc's crons. The scheduled handler
// serves every trigger and tells them apart by this expression, so the two have
// to stay in step.
//
// Hourly rather than daily because the limit above is per run, and a stage
// whose schema version changed leaves the entire corpus stale at once. Waiting
// a day per thousand activities makes a version bump a week-long migration.
// Selection depends on the previous batch having been consumed, so running this
// in a loop would keep reselecting the same oldest rows.
export const SWEEP_CRON = "30 * * * *";

export async function enqueueTransform(
  queue: Queue<TransformMessage>,
  messages: readonly TransformMessage[],
): Promise<number> {
  for (let index = 0; index < messages.length; index += SEND_BATCH) {
    const chunk = messages.slice(index, index + SEND_BATCH);
    await queue.sendBatch(chunk.map((body) => ({ body })));
  }
  return messages.length;
}

// The sweep is what makes the pipeline data-driven: an activity is enqueued
// because its stage output is missing or older than its input, never because
// of when it arrived.
export async function reconcileTransform(
  env: Env,
  limit = RECONCILE_LIMIT,
): Promise<number> {
  let enqueued = 0;
  for (const stage of SWEPT_STAGES) {
    const ids = await staleActivities(env.REGISTRY, stage, limit);
    enqueued += await enqueueTransform(
      env.TRANSFORM_QUEUE,
      ids.map((activityId) => ({ activityId, stage })),
    );
  }
  return enqueued;
}

// An upstream edit that leaves the raw bytes untouched still changes what the
// activity means, and no fingerprint can see that. Forcing drops the recorded
// row so the stage runs again regardless.
export async function enqueueActivity(
  env: Env,
  activityId: string,
  stage: Stage,
  force = false,
): Promise<void> {
  if (force) {
    await clearDerived(env.REGISTRY, activityId, stage);
  }
  await env.TRANSFORM_QUEUE.send({ activityId, stage });
}
