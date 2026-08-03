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

  it("refreshes and retries once when a live token gets a 401", async () => {
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
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ workouts: [] });
    });

    const response = await client(stub).fetch("/v1/workouts");

    expect(response.status).toBe(200);
    expect(stub.requests.map((request) => request.url)).toEqual([
      "https://api.example/v1/workouts",
      TOKEN_URL,
      "https://api.example/v1/workouts",
    ]);
    expect((await readTokens(env.TOKENS))?.refreshToken).toBe("next-refresh");
  });
});
