import { tracing } from "cloudflare:workers";
import type { IngestMessage } from "./ingest";

export type Attributes = Record<string, boolean | number | string | undefined>;

// Queue context does not reliably carry a trace from producer to consumer, so
// both sides stamp the same id and the two traces join by query instead. An
// ingest message names its ride by the source's id, because the hub's own
// activity id is minted only once the consumer reaches the registry. A Strava
// athlete event names an athlete, so it stays out of hub.source_id.
export function ingestAttributes(message: IngestMessage): Attributes {
  const base = { "hub.provider": message.source, "hub.message_kind": message.kind };
  if (message.source === "wahoo") {
    return {
      ...base,
      "hub.source_id": String(message.workoutId),
      "hub.correlation_id": `wahoo:${message.workoutId}`,
    };
  }
  if ("objectType" in message && message.objectType === "athlete") {
    return { ...base, "hub.correlation_id": `strava:athlete:${message.objectId}` };
  }
  return {
    ...base,
    "hub.source_id": String(message.objectId),
    "hub.correlation_id": `strava:${message.objectId}`,
  };
}

export function errorAttributes(error: unknown): Attributes {
  return error instanceof Error
    ? { "error.type": error.name, "hub.error": error.message }
    : { "error.type": "unknown", "hub.error": String(error) };
}

export async function traced<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      return await fn(span);
    } catch (error) {
      span.setAttributes(errorAttributes(error));
      throw error;
    }
  });
}

// Each message's span runs from the start of the batch to its ack or retry. A
// message the handler leaves unsettled takes the batch-wide call if one was
// made, and otherwise is acked when the handler returns or retried when it
// throws. Per-message calls override a batch-wide one, as the runtime's do.
export async function traceMessages<T>(
  batch: MessageBatch<T>,
  name: string,
  attributes: (message: Message<T>) => Attributes,
  consume: (batch: MessageBatch<T>) => Promise<void>,
): Promise<void> {
  const open = new Set<Span>();
  let batchOutcome: Attributes | undefined;
  const settle = (span: Span, outcome: Attributes): void => {
    if (!open.delete(span)) {
      return;
    }
    span.setAttributes(outcome);
    span.end();
  };

  const messages = batch.messages.map((message): Message<T> => {
    const span = tracing.startSpan(name);
    span.setAttributes({
      "hub.queue": batch.queue,
      "hub.attempts": message.attempts,
      ...attributes(message),
    });
    open.add(span);
    return {
      id: message.id,
      timestamp: message.timestamp,
      body: message.body,
      attempts: message.attempts,
      ack: () => {
        settle(span, { "hub.outcome": "ack" });
        message.ack();
      },
      retry: (options) => {
        settle(span, { "hub.outcome": "retry", "hub.retry_delay_s": options?.delaySeconds });
        message.retry(options);
      },
    };
  });

  try {
    // The runtime's batch keeps its fields on the prototype, so a spread would
    // drop them.
    await consume({
      queue: batch.queue,
      metadata: batch.metadata,
      messages,
      ackAll: () => {
        batchOutcome = { "hub.outcome": "ack" };
        batch.ackAll();
      },
      retryAll: (options) => {
        batchOutcome = { "hub.outcome": "retry", "hub.retry_delay_s": options?.delaySeconds };
        batch.retryAll(options);
      },
    });
  } catch (error) {
    for (const span of open) {
      settle(span, { ...(batchOutcome ?? { "hub.outcome": "retry" }), ...errorAttributes(error) });
    }
    throw error;
  }
  for (const span of open) {
    settle(span, batchOutcome ?? { "hub.outcome": "ack" });
  }
}
