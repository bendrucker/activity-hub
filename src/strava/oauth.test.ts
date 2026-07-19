import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import {
  exchangeCode,
  oauthConfig,
  readTokens,
  refreshTokens,
  TOKENS_KEY,
  writeTokens,
  type OAuthConfig,
  type StravaTokens,
} from "./oauth";

const CONFIG: OAuthConfig = {
  oauthBase: "https://oauth.example/oauth",
  clientId: "123",
  clientSecret: "shh",
};

const TOKENS: StravaTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1_800_000_000,
};

function respondJson(status: number, body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status });
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
});

describe("oauthConfig", () => {
  it("reads the OAuth settings from the environment", () => {
    const config = oauthConfig({ ...env, STRAVA_CLIENT_SECRET: "shh" });
    expect(config).toEqual({
      oauthBase: env.STRAVA_OAUTH_BASE,
      clientId: env.STRAVA_CLIENT_ID,
      clientSecret: "shh",
    });
  });

  it("throws when the client secret is unset", () => {
    const unset = { ...env, STRAVA_CLIENT_SECRET: undefined };
    expect(() => oauthConfig(unset as unknown as Env)).toThrow(
      /STRAVA_CLIENT_SECRET/,
    );
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
  it("posts the code with client credentials", async () => {
    const { fetchImpl, requests } = stubFetch(
      respondJson(200, {
        access_token: "access",
        refresh_token: "refresh",
        expires_at: 1_800_000_000,
        athlete: { id: 42 },
      }),
    );

    const { tokens, athleteId } = await exchangeCode(CONFIG, "abc", fetchImpl);

    expect(tokens).toEqual(TOKENS);
    expect(athleteId).toBe(42);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://oauth.example/oauth/token");
    const body = await requests[0]!.formData();
    expect(body.get("client_id")).toBe("123");
    expect(body.get("client_secret")).toBe("shh");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
  });

  it("throws on a failed exchange", async () => {
    const { fetchImpl } = stubFetch(respondJson(400, { message: "Bad" }));
    await expect(exchangeCode(CONFIG, "abc", fetchImpl)).rejects.toThrow(/400/);
  });
});

describe("refreshTokens", () => {
  it("posts the refresh token grant", async () => {
    const { fetchImpl, requests } = stubFetch(
      respondJson(200, {
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_at: 1_900_000_000,
      }),
    );

    const tokens = await refreshTokens(CONFIG, "refresh", fetchImpl);

    expect(tokens).toEqual({
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresAt: 1_900_000_000,
    });
    const body = await requests[0]!.formData();
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh");
  });
});
