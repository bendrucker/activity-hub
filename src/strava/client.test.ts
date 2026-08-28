import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { brokerSource, brokerStub, clearTokens, withBroker } from "../../test/broker";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import type { TokenBroker } from "../tokens/broker";
import { REFRESH_MARGIN_S, type StoredTokens } from "../tokens/source";
import { StravaClient } from "./client";

const TOKEN_URL = `${env.STRAVA_OAUTH_BASE}/token`;

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function client(broker: TokenBroker, stub: FetchStub): StravaClient {
  return new StravaClient({
    apiBase: "https://api.example/api/v3",
    tokens: brokerSource(broker, { fetch: stub.fetch }),
    fetch: stub.fetch,
  });
}

function seed(tokens: StoredTokens): Promise<void> {
  return brokerStub("strava").store(tokens);
}

function storedAccessToken(): Promise<string | undefined> {
  return brokerStub("strava")
    .current()
    .then((state) => state?.accessToken);
}

function refreshResponse(): Response {
  return Response.json({
    access_token: "fresh",
    refresh_token: "next-refresh",
    expires_at: nowS() + 21_600,
  });
}

beforeEach(async () => {
  await clearTokens("strava");
});

describe("StravaClient", () => {
  it("throws when no tokens are stored", async () => {
    const stub = stubFetch(() => new Response("{}"));

    await withBroker("strava", async (broker) => {
      await expect(client(broker, stub).fetch("/athlete")).rejects.toThrow(/auth\/strava/);
    });

    expect(stub.requests).toHaveLength(0);
  });

  it("sends bearer auth against the configured base", async () => {
    await seed({
      accessToken: "live",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch(() => Response.json({ id: 42 }));

    const response = await withBroker("strava", (broker) => client(broker, stub).fetch("/athlete"));

    expect(response.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.url).toBe("https://api.example/api/v3/athlete");
    expect(stub.requests[0]!.headers.get("Authorization")).toBe("Bearer live");
  });

  it("refreshes an expiring token before use and stores the result", async () => {
    await seed({
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: nowS() + 30,
    });
    const stub = stubFetch((request) => {
      if (request.url === TOKEN_URL) {
        return refreshResponse();
      }
      return Response.json({ id: 42 });
    });

    await withBroker("strava", (broker) => client(broker, stub).fetch("/athlete"));

    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.url).toBe(TOKEN_URL);
    expect(stub.requests[1]!.headers.get("Authorization")).toBe("Bearer fresh");
    expect(await storedAccessToken()).toBe("fresh");
  });

  it("refreshes and retries once when a live token gets a 401", async () => {
    await seed({
      accessToken: "revoked",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch((request) => {
      if (request.url === TOKEN_URL) {
        return refreshResponse();
      }
      if (request.headers.get("Authorization") === "Bearer revoked") {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ id: 42 });
    });

    const response = await withBroker("strava", (broker) => client(broker, stub).fetch("/athlete"));

    expect(response.status).toBe(200);
    expect(stub.requests.map((request) => request.url)).toEqual([
      "https://api.example/api/v3/athlete",
      TOKEN_URL,
      "https://api.example/api/v3/athlete",
    ]);
    expect(stub.requests[2]!.headers.get("Authorization")).toBe("Bearer fresh");
    expect(await storedAccessToken()).toBe("fresh");
  });

  it("calls the default fetch without workerd's illegal-invocation this", async () => {
    await seed({
      accessToken: "live",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const originalFetch = globalThis.fetch;
    // workerd's native fetch throws "Illegal invocation" when invoked with a
    // `this` other than undefined or globalThis. This stub mimics that check
    // to catch a regression to the old `this.fetch = fetch` assignment.
    globalThis.fetch = async function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect 'this' reference");
      }
      return Response.json({ id: 42 });
    } as typeof globalThis.fetch;

    try {
      const response = await withBroker("strava", (broker) =>
        new StravaClient({
          apiBase: "https://api.example/api/v3",
          tokens: brokerSource(broker),
        }).fetch("/athlete"),
      );
      expect(response.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
