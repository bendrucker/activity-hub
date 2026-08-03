import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import { SECRETS } from "../../test/secrets";
import {
  accessToken,
  exchangeCode,
  oauthConfig,
  readTokens,
  refreshTokens,
  TOKENS_KEY,
  writeTokens,
  type OAuthConfig,
  type WahooTokens,
} from "./oauth";

const CONFIG: OAuthConfig = {
  oauthBase: "https://oauth.example/oauth",
  clientId: "2348",
  clientSecret: "shh",
};

const TOKENS: WahooTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1_800_007_200,
};

const TOKEN_RESPONSE = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 7200,
  created_at: 1_800_000_000,
};

function respondJson(status: number, body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status });
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
});

describe("oauthConfig", () => {
  it("reads the OAuth settings from the environment", () => {
    const config = oauthConfig({ ...env, ...SECRETS });
    expect(config).toEqual({
      oauthBase: env.WAHOO_OAUTH_BASE,
      clientId: "2348",
      clientSecret: "wahoo-shh",
    });
  });

  it("throws when the client id or secret is unset", () => {
    expect(() =>
      oauthConfig({ ...env, ...SECRETS, WAHOO_CLIENT_ID: "" }),
    ).toThrow(/WAHOO_CLIENT_ID/);
    expect(() =>
      oauthConfig({ ...env, ...SECRETS, WAHOO_CLIENT_SECRET: "" }),
    ).toThrow(/WAHOO_CLIENT_SECRET/);
  });
});

describe("token storage", () => {
  it("roundtrips tokens through KV", async () => {
    expect(await readTokens(env.TOKENS)).toBeNull();
    await writeTokens(env.TOKENS, TOKENS);
    expect(await readTokens(env.TOKENS)).toEqual(TOKENS);
  });
});

describe("exchangeCode", () => {
  it("posts the code with client credentials and redirect_uri", async () => {
    const { fetchImpl, requests } = stubFetch(respondJson(200, TOKEN_RESPONSE));

    const tokens = await exchangeCode(
      CONFIG,
      "abc",
      "https://hub.example/auth/wahoo/callback",
      fetchImpl,
    );

    expect(tokens).toEqual(TOKENS);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://oauth.example/oauth/token");
    const body = await requests[0]!.formData();
    expect(body.get("client_id")).toBe("2348");
    expect(body.get("client_secret")).toBe("shh");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("redirect_uri")).toBe(
      "https://hub.example/auth/wahoo/callback",
    );
  });

  it("computes expiry from now when created_at is absent", async () => {
    const { fetchImpl } = stubFetch(
      respondJson(200, { ...TOKEN_RESPONSE, created_at: undefined }),
    );

    const before = Math.floor(Date.now() / 1000);
    const tokens = await exchangeCode(CONFIG, "abc", "https://cb", fetchImpl);

    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 7200);
    expect(tokens.expiresAt).toBeLessThanOrEqual(before + 7210);
  });

  it("throws on a failed exchange", async () => {
    const { fetchImpl } = stubFetch(respondJson(400, { error: "bad" }));
    await expect(
      exchangeCode(CONFIG, "abc", "https://cb", fetchImpl),
    ).rejects.toThrow(/400/);
  });
});

describe("refreshTokens", () => {
  it("posts the refresh token grant", async () => {
    const { fetchImpl, requests } = stubFetch(
      respondJson(200, {
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 7200,
        created_at: 1_900_000_000,
      }),
    );

    const tokens = await refreshTokens(CONFIG, "refresh", fetchImpl);

    expect(tokens).toEqual({
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresAt: 1_900_007_200,
    });
    const body = await requests[0]!.formData();
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh");
  });
});

describe("accessToken", () => {
  it("throws when no tokens are stored", async () => {
    const { fetchImpl } = stubFetch(() => new Response(null));
    await expect(accessToken(CONFIG, env.TOKENS, fetchImpl)).rejects.toThrow(
      /\/auth\/wahoo/,
    );
  });

  it("returns the stored token while fresh without fetching", async () => {
    await writeTokens(env.TOKENS, {
      ...TOKENS,
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
    });
    const { fetchImpl, requests } = stubFetch(() => {
      throw new Error("fresh tokens should not refresh");
    });

    expect(await accessToken(CONFIG, env.TOKENS, fetchImpl)).toBe("access");
    expect(requests).toHaveLength(0);
  });

  it("refreshes and persists the rotated pair when expired", async () => {
    await writeTokens(env.TOKENS, {
      ...TOKENS,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const { fetchImpl } = stubFetch(
      respondJson(200, {
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 7200,
        created_at: Math.floor(Date.now() / 1000),
      }),
    );

    expect(await accessToken(CONFIG, env.TOKENS, fetchImpl)).toBe(
      "next-access",
    );
    const stored = await readTokens(env.TOKENS);
    expect(stored?.refreshToken).toBe("next-refresh");
  });
});
