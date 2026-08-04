import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { WahooClient } from "./client";
import { REFRESH_MARGIN_S, TOKENS_KEY, readTokens, writeTokens } from "./oauth";

const OAUTH = {
  oauthBase: "https://api.example/oauth",
  clientId: "123",
  clientSecret: "shh",
};

const TOKEN_URL = "https://api.example/oauth/token";

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function client(stub: FetchStub): WahooClient {
  return new WahooClient({
    apiBase: "https://api.example",
    oauth: OAUTH,
    tokens: env.TOKENS,
    fetchImpl: stub.fetchImpl,
  });
}

function refreshResponse(): Response {
  return Response.json({
    access_token: "fresh",
    refresh_token: "next-refresh",
    expires_in: 7200,
    created_at: nowS(),
  });
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
});

describe("WahooClient", () => {
  it("throws when no tokens are stored", async () => {
    const stub = stubFetch(() => new Response("{}"));
    await expect(client(stub).fetch("/v1/workouts")).rejects.toThrow(
      /auth\/wahoo/,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it("sends bearer auth against the configured base", async () => {
    await writeTokens(env.TOKENS, {
      accessToken: "live",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch(() => Response.json({ workouts: [] }));

    const response = await client(stub).fetch("/v1/workouts");

    expect(response.status).toBe(200);
    expect(stub.requests[0]!.url).toBe("https://api.example/v1/workouts");
    expect(stub.requests[0]!.headers.get("Authorization")).toBe("Bearer live");
  });

  it("passes a workout-level 401 through when the token is live", async () => {
    await writeTokens(env.TOKENS, {
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

    const response = await client(stub).fetch("/v1/workouts/1/workout_summary");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: /not authorized/ });
    expect(stub.requests.map((request) => request.url)).toEqual([
      "https://api.example/v1/workouts/1/workout_summary",
    ]);
    expect((await readTokens(env.TOKENS))?.refreshToken).toBe("refresh");
  });

  it("refreshes when a live token's 401 reports revocation", async () => {
    await writeTokens(env.TOKENS, {
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

    const response = await client(stub).fetch("/v1/workouts");

    expect(response.status).toBe(200);
    expect((await readTokens(env.TOKENS))?.refreshToken).toBe("next-refresh");
  });

  it("retries with the stored token when another invocation rotated the pair", async () => {
    await writeTokens(env.TOKENS, {
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch(async (request) => {
      if (request.headers.get("Authorization") === "Bearer stale") {
        await writeTokens(env.TOKENS, {
          accessToken: "rotated",
          refreshToken: "rotated-refresh",
          expiresAt: nowS() + 7200,
        });
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ workouts: [] });
    });

    const response = await client(stub).fetch("/v1/workouts");

    expect(response.status).toBe(200);
    expect(
      stub.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual(["Bearer stale", "Bearer rotated"]);
  });

  it("refreshes and retries once when an expired token gets a 401", async () => {
    // Past the proactive margin at read time, so accessToken hands out the
    // stored token, and expired outright by the time the 401 comes back.
    await writeTokens(env.TOKENS, {
      accessToken: "revoked",
      refreshToken: "refresh",
      expiresAt: nowS() - 1,
    });
    const stub = stubFetch((request) => {
      if (request.url === TOKEN_URL) {
        return refreshResponse();
      }
      if (request.headers.get("Authorization") === "Bearer revoked") {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ workouts: [] });
    });

    const response = await client(stub).fetch("/v1/workouts");

    expect(response.status).toBe(200);
    expect((await readTokens(env.TOKENS))?.refreshToken).toBe("next-refresh");
  });
});
