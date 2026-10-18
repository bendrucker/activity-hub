import { describe, expect, it, vi } from "vitest";
import { traceMessages } from "./trace";

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

  it("settles every message through the batch-wide calls", async () => {
    const first = stubMessage("a");
    const second = stubMessage("b");

    await traceMessages(
      batchOf([first, second]),
      "test",
      () => ({}),
      async (batch) => {
        batch.retryAll({ delaySeconds: 30 });
      },
    );

    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(second.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
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
