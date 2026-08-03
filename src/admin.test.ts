import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../test/fetch-stub";
import { SECRETS } from "../test/secrets";
import { handleReconcile } from "./admin";
import type { StravaIngestMessage } from "./ingest";
import { StravaClient } from "./strava/client";
import { writeTokens } from "./strava/oauth";

interface QueueStub extends Queue<StravaIngestMessage> {
  messages: StravaIngestMessage[];
}

function stubQueue(): QueueStub {
  const messages: StravaIngestMessage[] = [];
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
  ADMIN_TOKEN?: string;
  INGEST_QUEUE?: Queue;
}

function testEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    ...env,
    ...SECRETS,
    INGEST_QUEUE: stubQueue(),
    ...overrides,
  };
}

function apiClient(stub: FetchStub): StravaClient {
  return new StravaClient({
    apiBase: "https://api.example/api/v3",
    oauth: {
      oauthBase: "https://oauth.example/oauth",
      clientId: "123",
      clientSecret: "shh",
    },
    tokens: env.TOKENS,
    fetchImpl: stub.fetchImpl,
  });
}

function reconcileRequest(authorization?: string): Request {
  return new Request("https://hub.example/admin/reconcile", {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

function listResponse(ids: number[]): Response {
  return new Response(JSON.stringify(ids.map((id) => ({ id }))));
}

beforeEach(async () => {
  await env.TOKENS.delete("strava:tokens");
  await writeTokens(env.TOKENS, {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 21_600,
  });
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
});

describe("handleReconcile", () => {
  it("rejects a request without an Authorization header", async () => {
    const response = await handleReconcile(reconcileRequest(), testEnv());
    expect(response.status).toBe(403);
  });

  it("rejects a wrong token", async () => {
    const response = await handleReconcile(
      reconcileRequest("Bearer wrong"),
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects any token when ADMIN_TOKEN is empty", async () => {
    const response = await handleReconcile(
      reconcileRequest("Bearer "),
      testEnv({ ADMIN_TOKEN: "" }),
    );
    expect(response.status).toBe(403);
  });

  it("reconciles and reports the enqueued count", async () => {
    const stub = stubFetch(() => listResponse([101, 102]));
    const queue = stubQueue();

    const response = await handleReconcile(
      reconcileRequest("Bearer admin-secret"),
      testEnv({ INGEST_QUEUE: queue }),
      { client: apiClient(stub) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, enqueued: 2 });
    expect(queue.messages.map((message) => message.objectId)).toEqual([
      101, 102,
    ]);
  });

  it("reports a Strava rate limit as a 429", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));

    const response = await handleReconcile(
      reconcileRequest("Bearer admin-secret"),
      testEnv(),
      { client: apiClient(stub) },
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("rate limited");
  });
});
