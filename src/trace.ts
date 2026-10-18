import { tracing } from "cloudflare:workers";
import type { IngestMessage } from "./ingest";

export type Attributes = Record<string, boolean | number | string | undefined>;

// Queue context does not reliably carry a trace from producer to consumer, so
// both sides stamp the same id and the two traces join by query instead. An
// ingest message names its ride by the source's id, because the hub's own
// activity id is minted only once the consumer reaches the registry.
export function ingestAttributes(message: IngestMessage): Attributes {
  const sourceId = message.source === "wahoo" ? message.workoutId : message.objectId;
  return {
    "hub.provider": message.source,
    "hub.message_kind": message.kind,
    "hub.source_id": String(sourceId),
    "hub.correlation_id": `${message.source}:${sourceId}`,
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

// The transform consumer settles each message wherever its activity's fate is
// decided, deep inside batch-wide reads and one container call, and a single
// message's work never sits inside one call of its own. Each message instead gets a span from the
// start of the batch to its ack or retry. A message the handler leaves
// unsettled is acked implicitly when it returns, or retried when it throws.
export async function traceMessages<T>(
  batch: MessageBatch<T>,
  name: string,
  attributes: (message: Message<T>) => Attributes,
  consume: (batch: MessageBatch<T>) => Promise<void>,
): Promise<void> {
  const open = new Set<Span>();
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
        for (const message of messages) {
          message.ack();
        }
      },
      retryAll: (options) => {
        for (const message of messages) {
          message.retry(options);
        }
      },
    });
  } catch (error) {
    for (const span of open) {
      settle(span, { "hub.outcome": "retry", ...errorAttributes(error) });
    }
    throw error;
  }
  for (const span of open) {
    settle(span, { "hub.outcome": "ack" });
  }
}
