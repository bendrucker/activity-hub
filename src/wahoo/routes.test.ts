import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SECRETS } from "../../test/secrets";
import { readTokens, TOKENS_KEY } from "./oauth";
import { handleAuthorize, handleCallback, SCOPES } from "./routes";

const testEnv: Env = { ...env, ...SECRETS };

const EXCHANGE = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 7200,
  created_at: 1_800_000_000,
};

function callbackUrl(params: Record<string, string>): URL {
  const url = new URL("https://hub.example/auth/wahoo/callback");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function stubExchange(): typeof fetch {
  return async () => Response.json(EXCHANGE);
}

function stubFailedExchange(): typeof fetch {
  return async () => new Response("Bad Request", { status: 400 });
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
});

describe("handleAuthorize", () => {
  it("redirects to Wahoo with the callback and scopes", () => {
    const response = handleAuthorize(
      new URL("https://hub.example/auth/wahoo"),
      testEnv,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(
      `${testEnv.WAHOO_OAUTH_BASE}/authorize`,
    );
    expect(location.searchParams.get("client_id")).toBe("2348");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://hub.example/auth/wahoo/callback",
    );
    expect(location.searchParams.get("scope")).toBe(SCOPES);
  });

  it("throws when the client credentials are unset", () => {
    expect(() =>
      handleAuthorize(new URL("https://hub.example/auth/wahoo"), {
        ...env,
        ...SECRETS,
        WAHOO_CLIENT_ID: "",
      }),
    ).toThrow(/WAHOO_CLIENT_ID/);
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

  it("reports a failed code exchange as a client error", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "expired" }),
      testEnv,
      stubFailedExchange(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("/auth/wahoo");
    expect(await readTokens(env.TOKENS)).toBeNull();
  });

  it("stores tokens on a successful exchange", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "abc" }),
      testEnv,
      stubExchange(),
    );

    expect(response.status).toBe(200);
    expect(await readTokens(env.TOKENS)).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_800_007_200,
    });
  });
});
