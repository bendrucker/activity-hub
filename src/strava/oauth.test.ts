import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  exchangeCode,
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

function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, requests };
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
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
    const { fetchImpl, requests } = stubFetch(200, {
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 1_800_000_000,
      athlete: { id: 42 },
    });

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
    const { fetchImpl } = stubFetch(400, { message: "Bad Request" });
    await expect(exchangeCode(CONFIG, "abc", fetchImpl)).rejects.toThrow(/400/);
  });
});

describe("refreshTokens", () => {
  it("posts the refresh token grant", async () => {
    const { fetchImpl, requests } = stubFetch(200, {
      access_token: "next-access",
      refresh_token: "next-refresh",
      expires_at: 1_900_000_000,
    });

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
