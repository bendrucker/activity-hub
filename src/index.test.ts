import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SECRETS } from "../test/secrets";
import { readConsumeLog } from "./consumelog";
import { consumeBatch } from "./index";
import { RateLimitedError, type IngestMessage } from "./ingest";

const testEnv: Env = { ...env, ...SECRETS };

const wahooMessage: IngestMessage = {
  source: "wahoo",
  kind: "workout",
  workoutId: 101,
  workout: {},
};

const stravaMessage: IngestMessage = {
  source: "strava",
  kind: "refresh",
  objectId: 202,
};

function stubMessage(body: IngestMessage) {
  return {
    id: `${body.source}-message`,
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batchOf(messages: ReturnType<typeof stubMessage>[]) {
  return {
    queue: "activity-hub-ingest",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<IngestMessage>;
}

function rejectWith(error: Error) {
  return () => Promise.reject(error);
}

beforeEach(async () => {
  await env.TOKENS.delete("debug:consume-log");
});

describe("consumeBatch", () => {
  it("acks a message the consumer handled", async () => {
    const message = stubMessage(wahooMessage);

    await consumeBatch(batchOf([message]), testEnv, {
      consume: () => Promise.resolve(),
    });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("waits out Wahoo's five-minute budget window on a rate limit", async () => {
    const message = stubMessage(wahooMessage);

    await consumeBatch(batchOf([message]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down")),
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 * 60 });
  });

  it("waits out Strava's fifteen-minute budget window on a rate limit", async () => {
    const message = stubMessage(stravaMessage);

    await consumeBatch(batchOf([message]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down")),
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 15 * 60 });
  });

  it("retries an ordinary failure on the short delay", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = stubMessage(wahooMessage);

    await consumeBatch(batchOf([message]), testEnv, {
      consume: rejectWith(new Error("boom")),
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    error.mockRestore();
  });

  it("keeps processing the batch after one message fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = stubMessage(wahooMessage);
    const succeeded = stubMessage(stravaMessage);

    await consumeBatch(batchOf([failed, succeeded]), testEnv, {
      consume: (message) =>
        message.source === "wahoo"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(),
    });

    expect(failed.retry).toHaveBeenCalled();
    expect(succeeded.ack).toHaveBeenCalled();
    error.mockRestore();
  });

  it("records each message's outcome in the consume log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = stubMessage(wahooMessage);
    const succeeded = stubMessage(stravaMessage);

    await consumeBatch(batchOf([failed, succeeded]), testEnv, {
      consume: (message) =>
        message.source === "wahoo"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(),
    });

    const entries = await readConsumeLog(env.TOKENS);
    expect(entries.map((entry) => [entry.id, entry.outcome])).toEqual([
      [101, "error: Error: boom"],
      [202, "ok"],
    ]);
    error.mockRestore();
  });
});
