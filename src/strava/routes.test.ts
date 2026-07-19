import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readTokens, TOKENS_KEY } from "./oauth";
import { handleAuthorize, handleCallback } from "./routes";

const testEnv: Env = { ...env, STRAVA_CLIENT_SECRET: "shh" };

const EXCHANGE = {
  access_token: "access",
  refresh_token: "refresh",
  expires_at: 1_800_000_000,
};

function callbackUrl(params: Record<string, string>): URL {
  const url = new URL("https://hub.example/auth/strava/callback");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function stubExchange(athleteId: number): typeof fetch {
  return async () => Response.json({ ...EXCHANGE, athlete: { id: athleteId } });
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
});

describe("handleAuthorize", () => {
  it("redirects to Strava with the callback and scope", () => {
    const response = handleAuthorize(
      new URL("https://hub.example/auth/strava"),
      testEnv,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(
      `${testEnv.STRAVA_OAUTH_BASE}/authorize`,
    );
    expect(location.searchParams.get("client_id")).toBe(
      testEnv.STRAVA_CLIENT_ID,
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://hub.example/auth/strava/callback",
    );
    expect(location.searchParams.get("scope")).toBe("activity:read_all");
  });
});

describe("handleCallback", () => {
  it("reports an authorization denial", async () => {
    const response = await handleCallback(
      callbackUrl({ error: "access_denied" }),
      testEnv,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("access_denied");
  });

  it("rejects a missing code", async () => {
    const response = await handleCallback(callbackUrl({}), testEnv);
    expect(response.status).toBe(400);
  });

  it("rejects a grant without activity:read_all", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "abc", scope: "read" }),
      testEnv,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("activity:read_all");
  });

  it("rejects another athlete without storing tokens", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "abc", scope: "read,activity:read_all" }),
      testEnv,
      stubExchange(999),
    );

    expect(response.status).toBe(403);
    expect(await readTokens(env.TOKENS)).toBeNull();
  });

  it("stores tokens for the configured athlete", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "abc", scope: "read,activity:read_all" }),
      testEnv,
      stubExchange(Number(testEnv.STRAVA_ATHLETE_ID)),
    );

    expect(response.status).toBe(200);
    expect(await readTokens(env.TOKENS)).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_800_000_000,
    });
  });
});
