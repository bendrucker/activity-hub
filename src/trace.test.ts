import { tracing } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestMessage } from "./ingest";
import { handleWebhookEvent } from "./strava/webhook";
import { errorAttributes, ingestAttributes, traceMessages, traced } from "./trace";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubSpan() {
  return { setAttributes: vi.fn(), end: vi.fn() };
}

// Hands `traced` a span the test can read, in place of the runtime's.
function captureSpan(): ReturnType<typeof stubSpan> {
  const span = stubSpan();
  vi.spyOn(tracing, "enterSpan").mockImplementation(((
    _name: string,
    callback: (s: Span) => unknown,
  ) => callback(span as unknown as Span)) as typeof tracing.enterSpan);
  return span;
}

function recorded(span: ReturnType<typeof stubSpan>): Record<string, unknown> {
  return Object.assign({}, ...span.setAttributes.mock.calls.map(([attributes]) => attributes));
}

describe("ingestAttributes", () => {
  it("names a Strava activity by its object id", () => {
    const message: IngestMessage = {
      source: "strava",
      kind: "create",
      objectType: "activity",
      objectId: 123,
      updates: {},
    };
    expect(ingestAttributes(message)).toEqual({
      "hub.provider": "strava",
      "hub.message_kind": "create",
      "hub.source_id": "123",
      "hub.correlation_id": "strava:123",
    });
  });

  it("keeps a Strava athlete out of the source id namespace", () => {
    const message: IngestMessage = {
      source: "strava",
      kind: "update",
      objectType: "athlete",
      objectId: 9,
      updates: { authorized: "false" },
    };
    expect(ingestAttributes(message)).toEqual({
      "hub.provider": "strava",
      "hub.message_kind": "update",
      "hub.correlation_id": "strava:athlete:9",
    });
  });

  it("names a Wahoo workout by its workout id", () => {
    const message: IngestMessage = {
      source: "wahoo",
      kind: "workout",
      workoutId: 456,
      workout: {},
    };
    expect(ingestAttributes(message)).toEqual({
      "hub.provider": "wahoo",
      "hub.message_kind": "workout",
      "hub.source_id": "456",
      "hub.correlation_id": "wahoo:456",
    });
  });
});

describe("errorAttributes", () => {
  it("records an Error's name and message", () => {
    expect(errorAttributes(new TypeError("bad"))).toEqual({
      "error.type": "TypeError",
      "hub.error": "bad",
    });
  });

  it("stringifies anything else", () => {
    expect(errorAttributes("boom")).toEqual({ "error.type": "unknown", "hub.error": "boom" });
  });
});

describe("traced", () => {
  it("stamps the error on the span and rethrows it", async () => {
    const span = captureSpan();

    await expect(
      traced("test", { "hub.provider": "strava" }, async () => {
        throw new Error("container unreachable");
      }),
    ).rejects.toThrow("container unreachable");
    expect(recorded(span)).toEqual({
      "hub.provider": "strava",
      "error.type": "Error",
      "hub.error": "container unreachable",
    });
  });
});

describe("Strava webhook", () => {
  it("stamps the correlation id before it enqueues", async () => {
    const span = stubSpan();
    const send = vi.fn(async () => {
      expect(recorded(span)["hub.correlation_id"]).toBe("strava:42");
    });
    const env = { STRAVA_SUBSCRIPTION_ID: "7", INGEST_QUEUE: { send } } as unknown as Env;
    const request = new Request("https://hub.test/webhooks/strava", {
      method: "POST",
      body: JSON.stringify({
        subscription_id: 7,
        aspect_type: "create",
        object_type: "activity",
        object_id: 42,
      }),
    });

    const response = await handleWebhookEvent(request, env, span as unknown as Span);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });
});

function stubMessage(id: string) {
  return {
    id,
    timestamp: new Date(0),
    attempts: 1,
    body: { id },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batchOf(messages: ReturnType<typeof stubMessage>[]) {
  return {
    queue: "activity-hub-transform",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ id: string }>;
}

describe("traceMessages", () => {
  it("hands the consumer the batch's messages and settles the originals", async () => {
    const acked = stubMessage("a");
    const retried = stubMessage("b");

    await traceMessages(
      batchOf([acked, retried]),
      "test",
      () => ({}),
      async (batch) => {
        expect(batch.queue).toBe("activity-hub-transform");
        expect(batch.messages.map((message) => message.body.id)).toEqual(["a", "b"]);
        batch.messages[0]!.ack();
        batch.messages[1]!.retry({ delaySeconds: 60 });
      },
    );

    expect(acked.ack).toHaveBeenCalledOnce();
    expect(retried.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("passes batch-wide calls to the runtime's batch", async () => {
    const first = stubMessage("a");
    const second = stubMessage("b");
    const original = batchOf([first, second]);

    await traceMessages(
      original,
      "test",
      () => ({}),
      async (batch) => {
        batch.retryAll({ delaySeconds: 30 });
        batch.messages[1]!.ack();
      },
    );

    expect(original.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
  });

  it("records each span's outcome, with a batch-wide call as the default", async () => {
    const spans = [stubSpan(), stubSpan()];
    vi.spyOn(tracing, "startSpan").mockImplementation(() => spans.shift() as unknown as Span);
    const [first, second] = [spans[0]!, spans[1]!];

    await traceMessages(
      batchOf([stubMessage("a"), stubMessage("b")]),
      "test",
      () => ({}),
      async (batch) => {
        batch.retryAll({ delaySeconds: 30 });
        batch.messages[1]!.ack();
      },
    );

    expect(recorded(first)["hub.outcome"]).toBe("retry");
    expect(recorded(first)["hub.retry_delay_s"]).toBe(30);
    expect(recorded(second)["hub.outcome"]).toBe("ack");
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
  });

  it("rethrows what the consumer throws", async () => {
    const message = stubMessage("a");

    await expect(
      traceMessages(
        batchOf([message]),
        "test",
        () => ({}),
        async () => {
          throw new Error("container unreachable");
        },
      ),
    ).rejects.toThrow("container unreachable");
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
