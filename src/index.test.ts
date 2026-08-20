import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubQueue } from "../test/queue-stub";
import { SECRETS } from "../test/secrets";
import { readConsumeLog } from "./consumelog";
import worker, { consumeBatch } from "./index";
import { RateLimitedError, type IngestMessage } from "./ingest";
import { PHOTO_CRON } from "./strava/backfill";
import { SWEEP_CRON } from "./transform/enqueue";
import type { TransformMessage } from "./transform/consume";

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

function stubMessage(body: IngestMessage, attempts = 1) {
  return {
    id: `${body.source}-message`,
    timestamp: new Date(0),
    attempts,
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
      consume: () => Promise.resolve(undefined),
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

  it("escalates to the next budget window as attempts accumulate", async () => {
    // A backlog bigger than the short window's budget keeps the hourly one
    // exhausted if every retry only waits out five minutes.
    const third = stubMessage(wahooMessage, 3);
    const seventh = stubMessage(wahooMessage, 7);

    await consumeBatch(batchOf([third]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down")),
    });
    await consumeBatch(batchOf([seventh]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down")),
    });

    expect(third.retry).toHaveBeenCalledWith({ delaySeconds: 15 * 60 });
    expect(seventh.retry).toHaveBeenCalledWith({ delaySeconds: 60 * 60 });
  });

  it("caps the wait at an hour however many attempts a message has", async () => {
    // `attempts` never resets, so a message that piled up attempts during an
    // outage must not stay parked once the hourly budget recovers.
    const weathered = stubMessage(wahooMessage, 400);

    await consumeBatch(batchOf([weathered]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down")),
    });

    expect(weathered.retry).toHaveBeenCalledWith({ delaySeconds: 60 * 60 });
  });

  it("prefers the delay the source asked for", async () => {
    const message = stubMessage(wahooMessage, 5);

    await consumeBatch(batchOf([message]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down", 90)),
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 90 });
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
          : Promise.resolve(undefined),
    });

    expect(failed.retry).toHaveBeenCalled();
    expect(succeeded.ack).toHaveBeenCalled();
    error.mockRestore();
  });

  it("parks the rest of a rate-limited source without attempting it", async () => {
    const messages = [
      stubMessage(wahooMessage),
      stubMessage(wahooMessage),
      stubMessage(wahooMessage),
    ];
    const consume = vi.fn(() =>
      Promise.reject(new RateLimitedError("slow down")),
    );

    await consumeBatch(batchOf(messages), testEnv, { consume });

    expect(consume).toHaveBeenCalledTimes(1);
    for (const message of messages) {
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 * 60 });
      expect(message.ack).not.toHaveBeenCalled();
    }
  });

  it("parks siblings on the same escalated delay, not the base one", async () => {
    const first = stubMessage(wahooMessage, 4);
    const sibling = stubMessage(wahooMessage, 1);

    await consumeBatch(batchOf([first, sibling]), testEnv, {
      consume: rejectWith(new RateLimitedError("slow down")),
    });

    expect(sibling.retry).toHaveBeenCalledWith({ delaySeconds: 60 * 60 });
  });

  it("keeps draining a source the rate limit did not touch", async () => {
    const limited = stubMessage(wahooMessage);
    const other = stubMessage(stravaMessage);

    await consumeBatch(batchOf([limited, other]), testEnv, {
      consume: (message) =>
        message.source === "wahoo"
          ? Promise.reject(new RateLimitedError("slow down"))
          : Promise.resolve(undefined),
    });

    expect(limited.retry).toHaveBeenCalledWith({ delaySeconds: 5 * 60 });
    expect(other.ack).toHaveBeenCalled();
  });

  it("records each message's outcome in the consume log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = stubMessage(wahooMessage);
    const succeeded = stubMessage(stravaMessage);

    await consumeBatch(batchOf([failed, succeeded]), testEnv, {
      consume: (message) =>
        message.source === "wahoo"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(undefined),
    });

    const entries = await readConsumeLog(env.TOKENS);
    expect(entries.map((entry) => [entry.id, entry.outcome])).toEqual([
      [101, "error: Error: boom"],
      [202, "ok"],
    ]);
    error.mockRestore();
  });

  it("logs the outcome the consumer returned instead of ok", async () => {
    const message = stubMessage(wahooMessage);

    await consumeBatch(batchOf([message]), testEnv, {
      consume: () => Promise.resolve("skipped: third-party sync stub"),
    });

    expect(message.ack).toHaveBeenCalled();
    const entries = await readConsumeLog(env.TOKENS);
    expect(entries.map((entry) => entry.outcome)).toEqual([
      "skipped: third-party sync stub",
    ]);
  });
});

describe("the scheduled handler", () => {
  // The sweep's own trigger has to return before the Strava reconciliation,
  // which needs credentials and the network. Losing that branch would also
  // drop the corpus back to a daily sweep cadence with nothing to show for it.
  it("runs only the transform sweep on the sweep cron", async () => {
    const seeded = "2026-01-01T00:00:00.000Z";
    await env.REGISTRY.prepare(
      `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at)
       VALUES ('a1', '2026-01-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?1, ?1)`,
    )
      .bind(seeded)
      .run();
    await env.REGISTRY.prepare(
      `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at, deleted_at)
       VALUES ('strava', '9001', 'a1', '{}', ?1, ?1, NULL)`,
    )
      .bind(seeded)
      .run();

    const sent: TransformMessage[] = [];
    const sweepEnv: Env = {
      ...testEnv,
      TRANSFORM_QUEUE: {
        sendBatch: (messages: Iterable<{ body: TransformMessage }>) => {
          for (const message of messages) {
            sent.push(message.body);
          }
          return Promise.resolve();
        },
      } as unknown as Env["TRANSFORM_QUEUE"],
    };

    await worker.scheduled(
      { cron: SWEEP_CRON, scheduledTime: 0, noRetry: () => undefined },
      sweepEnv,
    );

    expect(sent).toEqual([
      { activityId: "a1", stage: "decode" },
      { activityId: "a1", stage: "publish" },
    ]);
  });

  // It must enqueue photos rather than refreshes. A refresh spends two further
  // reads per activity.
  it("drains only the photo backfill targets on the photo cron", async () => {
    const seeded = "2026-01-01T00:00:00.000Z";
    await env.REGISTRY.batch([
      env.REGISTRY.prepare("DELETE FROM activity_sources"),
      env.REGISTRY.prepare("DELETE FROM activities"),
      env.REGISTRY.prepare("DELETE FROM photo_backfill_targets"),
    ]);
    await env.REGISTRY.prepare(
      `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at)
       VALUES ('a1', '2026-01-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?1, ?1)`,
    )
      .bind(seeded)
      .run();
    await env.REGISTRY.prepare(
      `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at)
       VALUES ('strava', '9001', 'a1', '{}', ?1, ?1)`,
    )
      .bind(seeded)
      .run();
    await env.REGISTRY.prepare(
      "INSERT INTO photo_backfill_targets (source_id, added_at) VALUES ('9001', ?1)",
    )
      .bind(seeded)
      .run();

    const ingest = stubQueue<IngestMessage>();
    const transform = stubQueue<TransformMessage>();

    await worker.scheduled(
      { cron: PHOTO_CRON, scheduledTime: 0, noRetry: () => undefined },
      { ...testEnv, INGEST_QUEUE: ingest, TRANSFORM_QUEUE: transform },
    );

    expect(ingest.messages).toEqual([
      { source: "strava", kind: "photos", objectId: 9001 },
    ]);
    expect(transform.messages).toEqual([]);
  });
});
