import {
  activityRawKeys,
  inputFingerprint,
  isCurrent,
  recordOutcome,
  type DerivedOutcome,
  type Stage,
} from "../derived";
import { decodeClient, type DecodeClient } from "./container";
import type { DecodeOutcome, DecodeWork } from "./protocol";

export interface TransformMessage {
  activityId: string;
  stage: Stage;
}

// One worker serves both queues through a single handler, which dispatches on
// the queue name.
export const TRANSFORM_QUEUE = "activity-hub-transform";

const RETRY_DELAY_S = 60;

export interface TransformBatchOptions {
  client?: DecodeClient;
}

export interface TransformSummary {
  decoded: number;
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
    current: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
  };

  // One activity can be queued twice before either message is drained: a
  // webhook edit landing on top of a reconciliation sweep, say. Both messages
  // resolve to the same raw bytes, so the activity is decoded once and both
  // are acked against that result.
  const pending = new Map<string, Pending>();

  for (const message of batch.messages) {
    const { activityId, stage } = message.body;
    if (stage !== "decode") {
      // Named in the table and the message shape, but nothing builds them yet.
      // Acking keeps a stray message from cycling to the dead letter queue.
      console.warn(`transform stage ${stage} is not implemented, dropping`);
      message.ack();
      continue;
    }

    const existing = pending.get(activityId);
    if (existing !== undefined) {
      existing.messages.push(message);
      continue;
    }

    try {
      const rawKeys = await activityRawKeys(env.REGISTRY, activityId);
      const fingerprint = await inputFingerprint(env.RAW, rawKeys);

      if (await isCurrent(env.REGISTRY, activityId, stage, fingerprint)) {
        summary.current += 1;
        message.ack();
        continue;
      }

      if (rawKeys.length === 0) {
        await recordOutcome(env.REGISTRY, {
          activityId,
          stage,
          inputFingerprint: fingerprint,
          status: "skipped",
          error: "activity has no archived original",
        });
        summary.skipped += 1;
        message.ack();
        continue;
      }

      pending.set(activityId, {
        activityId,
        fingerprint,
        rawKeys,
        messages: [message],
      });
    } catch (error) {
      // Reading the registry or heading R2 failed, which says nothing about
      // whether the activity is decodable. Retry rather than park a row.
      console.error(`failed to prepare ${activityId}: ${String(error)}`);
      message.retry({ delaySeconds: RETRY_DELAY_S });
      summary.retried += 1;
    }
  }

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
    outcomes = new Map(
      response.outcomes.map((outcome) => [outcome.activityId, outcome]),
    );
  } catch (error) {
    // The container is unreachable or answered non-2xx, so nothing here is
    // evidence about any single activity. The whole batch goes back.
    console.error(`decode batch failed: ${String(error)}`);
    for (const item of pending.values()) {
      retryAll(item, summary);
    }
    return summary;
  }

  for (const item of pending.values()) {
    const outcome = outcomes.get(item.activityId);
    if (outcome === undefined) {
      console.error(
        `decode container returned no outcome for ${item.activityId}`,
      );
      retryAll(item, summary);
      continue;
    }

    try {
      await recordOutcome(env.REGISTRY, derivedOutcome(item, outcome));
      count(summary, outcome);
      ackAll(item);
    } catch (error) {
      // The Parquet is already written. Failing to record that is a lost
      // update, and the retry is idempotent because the container overwrites
      // the same keys.
      console.error(`failed to record ${item.activityId}: ${String(error)}`);
      retryAll(item, summary);
    }
  }

  return summary;
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
        error:
          outcome.errors.length > 0 ? outcome.errors.join("; ") : undefined,
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
