import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REFRESH_MARGIN_S, StravaClient } from "./client";
import { TOKENS_KEY, readTokens, writeTokens } from "./oauth";

const OAUTH = {
  oauthBase: "https://oauth.example/oauth",
  clientId: "123",
  clientSecret: "shh",
};

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

interface Stub {
  fetchImpl: typeof fetch;
  requests: Request[];
}

function stubFetch(respond: (request: Request) => Response): Stub {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  };
  return { fetchImpl, requests };
}

function client(stub: Stub): StravaClient {
  return new StravaClient({
    apiBase: "https://api.example/api/v3",
    oauth: OAUTH,
    tokens: env.TOKENS,
    fetchImpl: stub.fetchImpl,
  });
}

beforeEach(async () => {
  await env.TOKENS.delete(TOKENS_KEY);
});

describe("StravaClient", () => {
  it("throws when no tokens are stored", async () => {
    const stub = stubFetch(() => new Response("{}"));
    await expect(client(stub).fetch("/athlete")).rejects.toThrow(
      /auth\/strava/,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it("sends bearer auth against the configured base", async () => {
    await writeTokens(env.TOKENS, {
      accessToken: "live",
      refreshToken: "refresh",
      expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    });
    const stub = stubFetch(() => Response.json({ id: 42 }));

    const response = await client(stub).fetch("/athlete");

    expect(response.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.url).toBe("https://api.example/api/v3/athlete");
    expect(stub.requests[0]!.headers.get("Authorization")).toBe("Bearer live");
  });

  it("refreshes an expiring token before use and stores the result", async () => {
    await writeTokens(env.TOKENS, {
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: nowS() + 30,
    });
    const stub = stubFetch((request) => {
      if (request.url === "https://oauth.example/oauth/token") {
        return Response.json({
          access_token: "fresh",
          refresh_token: "next-refresh",
          expires_at: nowS() + 21_600,
        });
      }
      return Response.json({ id: 42 });
    });

    await client(stub).fetch("/athlete");

    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.url).toBe("https://oauth.example/oauth/token");
    expect(stub.requests[1]!.headers.get("Authorization")).toBe("Bearer fresh");
    const stored = await readTokens(env.TOKENS);
    expect(stored?.accessToken).toBe("fresh");
    expect(stored?.refreshToken).toBe("next-refresh");
  });
});
