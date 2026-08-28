import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { brokerStub, clearTokens } from "../../test/broker";
import { SECRETS } from "../../test/secrets";
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

const USER_ID = 587205;

// The callback exchanges the code and then confirms whose account it is, so
// the stub answers both.
function stubExchange(userId: number | null = USER_ID): typeof fetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/user")) {
      return userId === null
        ? new Response("nope", { status: 401 })
        : Response.json({ id: userId });
    }
    return Response.json(EXCHANGE);
  };
}

function stubFailedExchange(): typeof fetch {
  return async () => new Response("Bad Request", { status: 400 });
}

beforeEach(async () => {
  await clearTokens("wahoo");
});

describe("handleAuthorize", () => {
  it("redirects to Wahoo with the callback and scopes", () => {
    const response = handleAuthorize(new URL("https://hub.example/auth/wahoo"), testEnv);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(`${testEnv.WAHOO_OAUTH_BASE}/authorize`);
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
    const response = await handleCallback(callbackUrl({ error: "access_denied" }), testEnv);
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
    expect(await brokerStub("wahoo").current()).toBeNull();
  });

  it("rejects an account that is not the configured user", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "abc" }),
      testEnv,
      stubExchange(999999),
    );

    expect(response.status).toBe(403);
    expect(await brokerStub("wahoo").current()).toBeNull();
  });

  it("refuses to store tokens it cannot attribute to an account", async () => {
    const response = await handleCallback(
      callbackUrl({ code: "abc" }),
      testEnv,
      stubExchange(null),
    );

    expect(response.status).toBe(502);
    expect(await brokerStub("wahoo").current()).toBeNull();
  });

  it("stores tokens on a successful exchange", async () => {
    const response = await handleCallback(callbackUrl({ code: "abc" }), testEnv, stubExchange());

    expect(response.status).toBe(200);
    expect(await brokerStub("wahoo").current()).toEqual({
      accessToken: "access",
      expiresAt: 1_800_007_200,
    });
  });
});
