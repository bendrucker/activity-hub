import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  brokerSource,
  brokerStub,
  clearTokens,
  withBroker,
} from "../../test/broker";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import type { TokenBroker } from "../tokens/broker";
import { REFRESH_MARGIN_S, type StoredTokens } from "../tokens/source";
import { WahooClient } from "./client";

const TOKEN_URL = `${env.WAHOO_OAUTH_BASE}/token`;

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function client(broker: TokenBroker, stub: FetchStub): WahooClient {
  return new WahooClient({
    apiBase: "https://api.example",
    tokens: brokerSource(broker, { fetch: stub.fetch }),
    fetch: stub.fetch,
  });
}

function seed(tokens: StoredTokens): Promise<void> {
  return brokerStub("wahoo").store(tokens);
}

function refreshResponse(): Response {
  return Response.json({
    access_token: "fresh",
    refresh_token: "next-refresh",
    expires_in: 7200,
    created_at: nowS(),
  });
}

function storedAccessToken(): Promise<string | undefined> {
  return brokerStub("wahoo")
    .current()
    .then((state) => state?.accessToken);
}

beforeEach(async () => {
  await clearTokens("wahoo");
});

describe("WahooClient", () => {
  it("throws when no tokens are stored", async () => {
    const stub = stubFetch(() => new Response("{}"));

    await withBroker("wahoo", async (broker) => {
      await expect(client(broker, stub).fetch("/v1/workouts")).rejects.toThrow(
        /auth\/wahoo/,
      );
    });

    expect(stub.requests).toHaveLength(0);
  });

  it("sends bearer auth against the configured base", async () => {
    await seed({
      accessToken: "live",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch(() => Response.json({ workouts: [] }));

    const response = await withBroker("wahoo", (broker) =>
      client(broker, stub).fetch("/v1/workouts"),
    );

    expect(response.status).toBe(200);
    expect(stub.requests[0]!.url).toBe("https://api.example/v1/workouts");
    expect(stub.requests[0]!.headers.get("Authorization")).toBe("Bearer live");
  });

  it("passes a workout-level 401 through when the token is live", async () => {
    await seed({
      accessToken: "live",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch(() =>
      Response.json(
        { error: "You are not authorized to view this workout summary" },
        { status: 401 },
      ),
    );

    const response = await withBroker("wahoo", (broker) =>
      client(broker, stub).fetch("/v1/workouts/1/workout_summary"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: /not authorized/ });
    expect(stub.requests.map((request) => request.url)).toEqual([
      "https://api.example/v1/workouts/1/workout_summary",
    ]);
    expect(await storedAccessToken()).toBe("live");
  });

  it("refreshes when a live token's 401 reports revocation", async () => {
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
        return Response.json(
          { error: "Access token has been revoked" },
          { status: 401 },
        );
      }
      return Response.json({ workouts: [] });
    });

    const response = await withBroker("wahoo", (broker) =>
      client(broker, stub).fetch("/v1/workouts"),
    );

    expect(response.status).toBe(200);
    expect(await storedAccessToken()).toBe("fresh");
  });

  it("retries with the stored token when another invocation rotated the pair", async () => {
    await seed({
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });

    const response = await withBroker("wahoo", async (broker) => {
      const stub = stubFetch(async (request) => {
        if (request.headers.get("Authorization") === "Bearer stale") {
          await broker.store({
            accessToken: "rotated",
            refreshToken: "rotated-refresh",
            expiresAt: nowS() + 7200,
          });
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json({ workouts: [] });
      });

      const result = await client(broker, stub).fetch("/v1/workouts");

      expect(
        stub.requests.map((request) => request.headers.get("Authorization")),
      ).toEqual(["Bearer stale", "Bearer rotated"]);
      return result;
    });

    expect(response.status).toBe(200);
    expect(await storedAccessToken()).toBe("rotated");
  });

  it("refreshes an expiring token before the request goes out", async () => {
    await seed({
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: nowS() - 1,
    });
    const stub = stubFetch((request) => {
      if (request.url === TOKEN_URL) {
        return refreshResponse();
      }
      return Response.json({ workouts: [] });
    });

    const response = await withBroker("wahoo", (broker) =>
      client(broker, stub).fetch("/v1/workouts"),
    );

    expect(response.status).toBe(200);
    expect(stub.requests[0]!.url).toBe(TOKEN_URL);
    expect(stub.requests[1]!.headers.get("Authorization")).toBe("Bearer fresh");
    expect(await storedAccessToken()).toBe("fresh");
  });
});
