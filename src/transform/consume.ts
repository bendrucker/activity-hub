import {
  activityRawKeysFor,
  currentFingerprints,
  inputFingerprint,
  recordOutcome,
  recordOutcomes,
  touchDerived,
  touchDerivedAll,
  type DerivedOutcome,
  type Stage,
} from "../derived";
import { decodeClient, type DecodeClient } from "./container";
import { enqueueTransform } from "./enqueue";
import type { DecodeOutcome, DecodeWork } from "./protocol";
import { publishToSite, type PublishOptions, type PublishResult } from "./publish";

export interface TransformMessage {
  activityId: string;
  stage: Stage;
}

// One worker serves both queues through a single handler, which dispatches on
// the queue name.
export const TRANSFORM_QUEUE = "activity-hub-transform";

const RETRY_DELAY_S = 60;

export interface TransformBatchOptions extends PublishOptions {
  client?: DecodeClient;
}

export interface TransformSummary {
  decoded: number;
  published: number;
  current: number;
  skipped: number;
  failed: number;
  retried: number;
}

type Pending = {
  activityId: string;
  fingerprint: string;
  rawKeys: string[];
  messages: Message<TransformMessage>[];
};

export async function consumeTransformBatch(
  batch: MessageBatch<TransformMessage>,
  env: Env,
  options: TransformBatchOptions = {},
): Promise<TransformSummary> {
  const summary: TransformSummary = {
    decoded: 0,
    published: 0,
    current: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
  };

  // One activity can be queued twice before either message is drained: a
  // webhook edit landing on top of a reconciliation sweep, say. Both messages
  // resolve to the same raw bytes, so the activity is decoded once and both
  // are acked against that result. Grouping before any read is also what lets
  // the registry answer for the whole batch at once below.
  const queued = new Map<string, Message<TransformMessage>[]>();

  for (const message of batch.messages) {
    const { activityId, stage } = message.body;
    if (stage === "publish") {
      await consumePublish(activityId, message, env, options, summary);
      continue;
    }
    if (stage !== "decode") {
      // The lake stage has no per-activity grain, so a message naming it is a
      // stray. Acking keeps it from cycling to the dead letter queue.
      console.warn(`transform stage ${stage} is not per-activity, dropping`);
      message.ack();
      continue;
    }

    const existing = queued.get(activityId);
    if (existing === undefined) {
      queued.set(activityId, [message]);
    } else {
      existing.push(message);
    }
  }

  const pending = await prepareDecodes(queued, env, summary);

  if (pending.size === 0) {
    return summary;
  }

  const work: DecodeWork[] = [...pending.values()].map((item) => ({
    activityId: item.activityId,
    rawKeys: item.rawKeys,
  }));

  let outcomes: Map<string, DecodeOutcome>;
  try {
    const client = options.client ?? decodeClient(env);
    const response = await client.decode({ work });
    outcomes = new Map(response.outcomes.map((outcome) => [outcome.activityId, outcome]));
  } catch (error) {
    // The container is unreachable or answered non-2xx, so nothing here is
    // evidence about any single activity. The whole batch goes back.
    console.error(`decode batch failed: ${String(error)}`);
    for (const item of pending.values()) {
      retryAll(item, summary);
    }
    return summary;
  }

  const decoded: { item: Pending; outcome: DecodeOutcome }[] = [];
  for (const item of pending.values()) {
    const outcome = outcomes.get(item.activityId);
    if (outcome === undefined) {
      console.error(`decode container returned no outcome for ${item.activityId}`);
      retryAll(item, summary);
      continue;
    }
    decoded.push({ item, outcome });
  }

  if (decoded.length === 0) {
    return summary;
  }

  try {
    await recordOutcomes(
      env.REGISTRY,
      decoded.map(({ item, outcome }) => derivedOutcome(item, outcome)),
    );
    // The staleness query would pick these up on the next sweep anyway. The
    // chain is what makes a new ride reach the site in minutes rather than by
    // tomorrow morning.
    await enqueueTransform(
      env.TRANSFORM_QUEUE,
      decoded
        .filter(({ outcome }) => outcome.status === "ok")
        .map(({ item }) => ({ activityId: item.activityId, stage: "publish" })),
    );
    for (const { item, outcome } of decoded) {
      count(summary, outcome);
      ackAll(item);
    }
  } catch (error) {
    // The Parquet is already written. Failing to record that is a lost update,
    // and the retry is idempotent because the container overwrites the same
    // keys. Recording the whole batch as one D1 transaction means one failure
    // takes every activity in it back to the queue, which is the same
    // granularity the decode call above already retries at.
    console.error(`failed to record decode batch: ${String(error)}`);
    for (const { item } of decoded) {
      retryAll(item, summary);
    }
  }

  return summary;
}

// The registry answers for the whole batch rather than per message: two reads
// and one write, against the two reads and up to two writes per activity this
// replaced. At a batch of thirty that is the difference between roughly ninety
// subrequests and three.
//
// Batching widens what one failure takes down, the same trade the recording
// side already makes. A read that covers every activity says nothing about any
// one of them, so a failure sends the whole batch back rather than parking
// rows. Heading R2 stays per activity, so a single unreadable object only
// costs its own activity.
async function prepareDecodes(
  queued: Map<string, Message<TransformMessage>[]>,
  env: Env,
  summary: TransformSummary,
): Promise<Map<string, Pending>> {
  const pending = new Map<string, Pending>();
  const activityIds = [...queued.keys()];
  if (activityIds.length === 0) {
    return pending;
  }

  const retryFor = (activityId: string): void => {
    for (const message of queued.get(activityId) ?? []) {
      message.retry({ delaySeconds: RETRY_DELAY_S });
      summary.retried += 1;
    }
  };
  const ackFor = (activityId: string): void => {
    for (const message of queued.get(activityId) ?? []) {
      message.ack();
    }
  };

  let rawKeysById: Map<string, string[]>;
  let currentById: Map<string, string>;
  try {
    rawKeysById = await activityRawKeysFor(env.REGISTRY, activityIds);
    currentById = await currentFingerprints(env.REGISTRY, "decode", activityIds);
  } catch (error) {
    console.error(`failed to read the registry for ${activityIds.length}: ${String(error)}`);
    for (const activityId of activityIds) {
      retryFor(activityId);
    }
    return pending;
  }

  // Independent per activity once the grouping above has run, so these go out
  // together rather than one round trip after another.
  const heads = await Promise.all(
    activityIds.map(async (activityId) => {
      const rawKeys = rawKeysById.get(activityId) ?? [];
      try {
        return { activityId, rawKeys, fingerprint: await inputFingerprint(env.RAW, rawKeys) };
      } catch (error) {
        // Heading R2 failed, which says nothing about whether the activity is
        // decodable. Retry rather than park a row.
        console.error(`failed to fingerprint ${activityId}: ${String(error)}`);
        return { activityId, rawKeys, fingerprint: null };
      }
    }),
  );

  const current: string[] = [];
  const skipped: DerivedOutcome[] = [];

  for (const { activityId, rawKeys, fingerprint } of heads) {
    if (fingerprint === null) {
      retryFor(activityId);
      continue;
    }
    if (currentById.get(activityId) === fingerprint) {
      current.push(activityId);
      continue;
    }
    if (rawKeys.length === 0) {
      skipped.push({
        activityId,
        stage: "decode",
        inputFingerprint: fingerprint,
        status: "skipped",
        error: "activity has no archived original",
      });
      continue;
    }
    pending.set(activityId, {
      activityId,
      fingerprint,
      rawKeys,
      messages: queued.get(activityId) ?? [],
    });
  }

  // Stamping swallows its own failures, so these ack either way.
  await touchDerivedAll(env.REGISTRY, "decode", current);
  for (const activityId of current) {
    summary.current += 1;
    ackFor(activityId);
  }

  if (skipped.length > 0) {
    try {
      await recordOutcomes(env.REGISTRY, skipped);
      for (const { activityId } of skipped) {
        summary.skipped += 1;
        ackFor(activityId);
      }
    } catch (error) {
      // Acking without the row would drop the activity: the sweep reselects it
      // only because no row says it was tried.
      console.error(`failed to record ${skipped.length} skipped: ${String(error)}`);
      for (const { activityId } of skipped) {
        retryFor(activityId);
      }
    }
  }

  return pending;
}

// One activity at a time: the container reads that activity's Parquet and
// nothing about the work is shared across a batch, so batching would only make
// one bad artifact everyone else's retry.
async function consumePublish(
  activityId: string,
  message: Message<TransformMessage>,
  env: Env,
  options: TransformBatchOptions,
  summary: TransformSummary,
): Promise<void> {
  let result: PublishResult;
  try {
    result = await publishToSite(env, activityId, options);
  } catch (error) {
    // The site rejected the row's shape, which no retry changes. Anything else
    // (the container, D1, R2, a service binding that could not connect) says
    // nothing about this activity.
    if (!(error instanceof Error) || error.name !== "ValidationError") {
      console.error(`failed to publish ${activityId}: ${String(error)}`);
      message.retry({ delaySeconds: RETRY_DELAY_S });
      summary.retried += 1;
      return;
    }
    result = {
      fingerprint: "rejected",
      status: "failed",
      error: error.message,
    };
  }

  if (result.status === "current") {
    await touchDerived(env.REGISTRY, activityId, "publish");
    summary.current += 1;
    message.ack();
    return;
  }

  try {
    await recordOutcome(env.REGISTRY, {
      activityId,
      stage: "publish",
      inputFingerprint: result.fingerprint,
      status: result.status,
      error: result.status === "ok" ? undefined : reason(result),
    });
  } catch (error) {
    console.error(`failed to record publish ${activityId}: ${String(error)}`);
    message.retry({ delaySeconds: RETRY_DELAY_S });
    summary.retried += 1;
    return;
  }

  if (result.status === "ok") {
    summary.published += 1;
  } else if (result.status === "skipped") {
    summary.skipped += 1;
  } else {
    summary.failed += 1;
  }
  message.ack();
}

function reason(result: PublishResult): string | undefined {
  if (result.status === "skipped") {
    return result.reason;
  }
  return result.status === "failed" ? result.error : undefined;
}

function derivedOutcome(item: Pending, outcome: DecodeOutcome): DerivedOutcome {
  const base = {
    activityId: item.activityId,
    stage: "decode" as const,
    inputFingerprint: item.fingerprint,
  };
  switch (outcome.status) {
    case "ok":
      return {
        ...base,
        status: "ok",
        outputKey: outcome.outputKey,
        // Non-fatal decode errors ride along on a successful row. A device
        // that died mid-ride still produced usable rows, and the note is what
        // explains a short one later.
        error: outcome.errors.length > 0 ? outcome.errors.join("; ") : undefined,
      };
    case "failed":
      return { ...base, status: "failed", error: outcome.error };
    case "skipped":
      return { ...base, status: "skipped", error: outcome.reason };
  }
}

function count(summary: TransformSummary, outcome: DecodeOutcome): void {
  switch (outcome.status) {
    case "ok":
      summary.decoded += 1;
      return;
    case "failed":
      summary.failed += 1;
      return;
    case "skipped":
      summary.skipped += 1;
  }
}

function ackAll(item: Pending): void {
  for (const message of item.messages) {
    message.ack();
  }
}

function retryAll(item: Pending, summary: TransformSummary): void {
  for (const message of item.messages) {
    message.retry({ delaySeconds: RETRY_DELAY_S });
    summary.retried += 1;
  }
}
