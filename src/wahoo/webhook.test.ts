import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { stubQueue } from "../../test/queue-stub";
import { SECRETS } from "../../test/secrets";
import type { IngestMessage } from "../ingest";
import { handleWebhookEvent } from "./webhook";

interface TestEnvOverrides {
  WAHOO_WEBHOOK_TOKEN?: string;
  INGEST_QUEUE?: Queue;
}

function testEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    ...env,
    ...SECRETS,
    INGEST_QUEUE: stubQueue(),
    ...overrides,
  } as Env;
}

function eventRequest(body: unknown): Request {
  return new Request("https://hub.example/webhooks/wahoo", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const SUMMARY = {
  id: 8297,
  duration_total_accum: "275.20",
  distance_accum: "24909.71",
  file: { url: "https://cdn.wahooligan.com/workout_file/file/abc/2026.fit" },
  workout: {
    id: 56519,
    starts: "2026-07-01T14:00:00.000Z",
    minutes: 12,
    name: "Morning Ride",
    workout_type_id: 0,
  },
};

const EVENT = {
  event_type: "workout_summary",
  webhook_token: "hook-token",
  user: { id: 60462 },
  workout_summary: SUMMARY,
};

describe("handleWebhookEvent", () => {
  it("enqueues the ingest message for a valid workout_summary event", async () => {
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest(EVENT),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([
      {
        source: "wahoo",
        kind: "workout_summary",
        workoutId: 56519,
        summary: SUMMARY,
      } satisfies IngestMessage,
    ]);
  });

  it("rejects a webhook_token mismatch without enqueueing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({ ...EVENT, webhook_token: "wrong" }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(403);
    expect(queue.messages).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects every event when WAHOO_WEBHOOK_TOKEN is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({ ...EVENT, webhook_token: "" }),
      testEnv({ WAHOO_WEBHOOK_TOKEN: "", INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(403);
    expect(queue.messages).toEqual([]);
    warn.mockRestore();
  });

  it("accepts but does not enqueue an unknown event_type", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({ ...EVENT, event_type: "deauthorized" }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deauthorized"));
    warn.mockRestore();
  });

  it("accepts but does not enqueue a summary without a file url", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({
        ...EVENT,
        workout_summary: { ...SUMMARY, file: {} },
      }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([]);
    warn.mockRestore();
  });

  it("accepts but does not enqueue a summary without a workout id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({
        ...EVENT,
        workout_summary: {
          ...SUMMARY,
          workout: { ...SUMMARY.workout, id: "x" },
        },
      }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([]);
    warn.mockRestore();
  });

  it("rejects a non-JSON body", async () => {
    const response = await handleWebhookEvent(
      eventRequest("not json"),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });
});
