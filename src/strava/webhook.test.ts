import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { IngestMessage } from "../ingest";
import { handleWebhookEvent, handleWebhookVerify } from "./webhook";

interface QueueStub extends Queue<unknown> {
  messages: unknown[];
}

function stubQueue(): QueueStub {
  const messages: unknown[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(batch) {
      for (const item of batch) {
        messages.push(item.body);
      }
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
}

interface TestEnvOverrides {
  STRAVA_VERIFY_TOKEN?: string;
  STRAVA_SUBSCRIPTION_ID?: string;
  INGEST_QUEUE?: Queue;
}

// wrangler types narrows committed vars to their literal value, but tests
// need to exercise other subscription ids, so this widens back to `string`.
function testEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    ...env,
    STRAVA_CLIENT_SECRET: "shh",
    STRAVA_VERIFY_TOKEN: "verify-me",
    STRAVA_SUBSCRIPTION_ID: "999",
    INGEST_QUEUE: stubQueue(),
    ...overrides,
  } as Env;
}

function verifyUrl(params: Record<string, string>): URL {
  const url = new URL("https://hub.example/webhooks/strava");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function eventRequest(body: unknown): Request {
  return new Request("https://hub.example/webhooks/strava", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const CREATE_EVENT = {
  object_type: "activity",
  object_id: 12345,
  aspect_type: "create",
  updates: {},
  owner_id: 5723594,
  subscription_id: 999,
  event_time: 1_800_000_000,
};

describe("handleWebhookVerify", () => {
  it("echoes the challenge as JSON when the token matches", () => {
    const response = handleWebhookVerify(
      verifyUrl({ "hub.challenge": "abc", "hub.verify_token": "verify-me" }),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns the challenge value it echoes", async () => {
    const response = handleWebhookVerify(
      verifyUrl({ "hub.challenge": "abc", "hub.verify_token": "verify-me" }),
      testEnv(),
    );
    expect(await response.json()).toEqual({ "hub.challenge": "abc" });
  });

  it("rejects a token mismatch", () => {
    const response = handleWebhookVerify(
      verifyUrl({ "hub.challenge": "abc", "hub.verify_token": "wrong" }),
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects any token when STRAVA_VERIFY_TOKEN is empty", () => {
    const response = handleWebhookVerify(
      verifyUrl({ "hub.challenge": "abc", "hub.verify_token": "" }),
      testEnv({ STRAVA_VERIFY_TOKEN: "" }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a missing challenge", () => {
    const response = handleWebhookVerify(
      verifyUrl({ "hub.verify_token": "verify-me" }),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });
});

describe("handleWebhookEvent", () => {
  it("enqueues the ingest message for a valid create event", async () => {
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest(CREATE_EVENT),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([
      {
        source: "strava",
        kind: "create",
        objectType: "activity",
        objectId: 12345,
        updates: {},
      } satisfies IngestMessage,
    ]);
  });

  it.each(["update", "delete"] as const)(
    "maps aspect_type %s to kind",
    async (aspectType) => {
      const queue = stubQueue();
      await handleWebhookEvent(
        eventRequest({ ...CREATE_EVENT, aspect_type: aspectType }),
        testEnv({ INGEST_QUEUE: queue }),
      );

      expect(queue.messages).toEqual([
        expect.objectContaining({ kind: aspectType }),
      ]);
    },
  );

  it("rejects an unknown subscription id without enqueueing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({ ...CREATE_EVENT, subscription_id: 1 }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(403);
    expect(queue.messages).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1"));
    warn.mockRestore();
  });

  it("rejects every event when STRAVA_SUBSCRIPTION_ID is empty", async () => {
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest(CREATE_EVENT),
      testEnv({ STRAVA_SUBSCRIPTION_ID: "", INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(403);
    expect(queue.messages).toEqual([]);
  });

  it("accepts but does not enqueue a non-numeric object_id", async () => {
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({ ...CREATE_EVENT, object_id: "abc" }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([]);
  });

  it("accepts but does not enqueue an unknown aspect_type", async () => {
    const queue = stubQueue();
    const response = await handleWebhookEvent(
      eventRequest({ ...CREATE_EVENT, aspect_type: "archive" }),
      testEnv({ INGEST_QUEUE: queue }),
    );

    expect(response.status).toBe(200);
    expect(queue.messages).toEqual([]);
  });

  it("rejects a non-JSON body", async () => {
    const response = await handleWebhookEvent(
      eventRequest("not json"),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });
});
