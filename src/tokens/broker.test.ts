import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { brokerStub, clearTokens, withBroker } from "../../test/broker";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import { SECRETS } from "../../test/secrets";
import { TOKENS_KEY as STRAVA_TOKENS_KEY } from "../strava/oauth";
import { TOKENS_KEY as WAHOO_TOKENS_KEY } from "../wahoo/oauth";
import { REFRESH_MARGIN_S, type StoredTokens } from "./source";

const WAHOO_TOKEN_URL = `${env.WAHOO_OAUTH_BASE}/token`;
const STRAVA_TOKEN_URL = `${env.STRAVA_OAUTH_BASE}/token`;

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function live(tokens: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: "live",
    refreshToken: "refresh",
    expiresAt: nowS() + REFRESH_MARGIN_S * 2,
    ...tokens,
  };
}

function expired(tokens: Partial<StoredTokens> = {}): StoredTokens {
  return live({ accessToken: "stale", expiresAt: nowS() - 1, ...tokens });
}

async function seedKv(key: string, tokens: StoredTokens): Promise<void> {
  await env.TOKENS.put(key, JSON.stringify(tokens));
}

function wahooRefresh(): FetchStub {
  return stubFetch(async (request) => {
    expect(request.url).toBe(WAHOO_TOKEN_URL);
    return Response.json({
      access_token: "fresh",
      refresh_token: "next-refresh",
      expires_in: 7200,
      created_at: nowS(),
    });
  });
}

beforeEach(async () => {
  await clearTokens("wahoo");
  await clearTokens("strava");
});

describe("TokenBroker", () => {
  it("throws with the provider's authorize path when nothing is stored", async () => {
    await expect(withBroker("wahoo", (broker) => broker.accessToken())).rejects.toThrow(
      /no Wahoo tokens stored; authorize at \/auth\/wahoo/,
    );
    await expect(withBroker("strava", (broker) => broker.accessToken())).rejects.toThrow(
      /no Strava tokens stored; authorize at \/auth\/strava/,
    );
  });

  it("reports no state before a pair is stored", async () => {
    expect(await withBroker("wahoo", (broker) => broker.current())).toBeNull();
  });

  it("hands out a stored token while it is live", async () => {
    const stub = stubFetch(() => {
      throw new Error("a live token must not refresh");
    });

    const token = await withBroker("wahoo", async (broker) => {
      await broker.store(live());
      return broker.accessToken({ fetch: stub.fetch });
    });

    expect(token).toBe("live");
    expect(stub.requests).toHaveLength(0);
  });

  describe("seeding", () => {
    it("adopts the pair KV already holds", async () => {
      await seedKv(WAHOO_TOKENS_KEY, live({ accessToken: "from-kv" }));

      expect(await withBroker("wahoo", (broker) => broker.accessToken())).toBe("from-kv");
      expect(await withBroker("wahoo", (broker) => broker.current())).toMatchObject({
        accessToken: "from-kv",
      });
    });

    it("reads each provider's own KV key", async () => {
      await seedKv(WAHOO_TOKENS_KEY, live({ accessToken: "wahoo-kv" }));
      await seedKv(STRAVA_TOKENS_KEY, live({ accessToken: "strava-kv" }));

      expect(await withBroker("wahoo", (broker) => broker.accessToken())).toBe("wahoo-kv");
      expect(await withBroker("strava", (broker) => broker.accessToken())).toBe("strava-kv");
    });

    it("stops consulting KV once it holds a pair", async () => {
      await seedKv(WAHOO_TOKENS_KEY, live({ accessToken: "from-kv" }));
      await withBroker("wahoo", (broker) => broker.accessToken());

      await seedKv(WAHOO_TOKENS_KEY, live({ accessToken: "stale-kv" }));

      expect(await withBroker("wahoo", (broker) => broker.accessToken())).toBe("from-kv");
    });

    it("does not write back the pair it just adopted", async () => {
      await seedKv(WAHOO_TOKENS_KEY, live());
      const put = vi.spyOn(env.TOKENS, "put");

      await withBroker("wahoo", (broker) => broker.accessToken());

      expect(put).not.toHaveBeenCalled();
      put.mockRestore();
    });
  });

  // A rollback would put the pre-broker code back in charge, and it refreshes
  // straight from KV. A spent refresh token there costs the whole grant.
  describe("the KV shadow copy", () => {
    it("holds the fresh pair after a rotation", async () => {
      await seedKv(WAHOO_TOKENS_KEY, expired({ refreshToken: "kv-refresh" }));
      const stub = wahooRefresh();

      await withBroker("wahoo", (broker) => broker.accessToken({ fetch: stub.fetch }));

      expect(await env.TOKENS.get<StoredTokens>(WAHOO_TOKENS_KEY, "json")).toMatchObject({
        accessToken: "fresh",
        refreshToken: "next-refresh",
      });
    });

    it("takes the pair an OAuth callback stores", async () => {
      await withBroker("strava", (broker) => broker.store(live({ accessToken: "reauthorized" })));

      expect(await env.TOKENS.get<StoredTokens>(STRAVA_TOKENS_KEY, "json")).toMatchObject({
        accessToken: "reauthorized",
      });
    });

    it("cannot fail a rotation", async () => {
      const stub = wahooRefresh();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const put = vi.spyOn(env.TOKENS, "put").mockRejectedValue(new Error("KV unavailable"));

      const token = await withBroker("wahoo", async (broker) => {
        await broker.store(expired());
        return broker.accessToken({ fetch: stub.fetch });
      });

      expect(token).toBe("fresh");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("KV unavailable"));
      put.mockRestore();
      warn.mockRestore();

      expect(await withBroker("wahoo", (broker) => broker.current())).toMatchObject({
        accessToken: "fresh",
      });
    });
  });

  describe("refresh", () => {
    it("rotates an expiring pair and persists the replacement", async () => {
      const stub = wahooRefresh();

      // The request body is an I/O object owned by the Durable Object's
      // context, so it has to be read there.
      const grants = await withBroker("wahoo", async (broker) => {
        await broker.store(expired());
        expect(await broker.accessToken({ fetch: stub.fetch })).toBe("fresh");
        return Promise.all(
          stub.requests.map(async (request) => Object.fromEntries(await request.formData())),
        );
      });

      expect(grants).toEqual([
        {
          client_id: SECRETS.WAHOO_CLIENT_ID,
          client_secret: SECRETS.WAHOO_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: "refresh",
        },
      ]);
      expect(await withBroker("wahoo", (broker) => broker.current())).toMatchObject({
        accessToken: "fresh",
      });
    });

    it("sends one upstream request for concurrent callers", async () => {
      const stub = wahooRefresh();

      const tokens = await withBroker("wahoo", async (broker) => {
        await broker.store(expired());
        return Promise.all([
          broker.accessToken({ fetch: stub.fetch }),
          broker.accessToken({ fetch: stub.fetch }),
          broker.accessToken({ fetch: stub.fetch }),
        ]);
      });

      expect(tokens).toEqual(["fresh", "fresh", "fresh"]);
      expect(stub.requests).toHaveLength(1);
    });

    it("spends no request when the pair already rotated past the caller", async () => {
      const stub = stubFetch(() => {
        throw new Error("a rotated pair must not refresh again");
      });

      const token = await withBroker("wahoo", async (broker) => {
        await broker.store(live({ accessToken: "rotated" }));
        return broker.refresh("stale", { fetch: stub.fetch });
      });

      expect(token).toBe("rotated");
      expect(stub.requests).toHaveLength(0);
    });

    it("rotates when the caller's token is still the stored one", async () => {
      const stub = wahooRefresh();

      const token = await withBroker("wahoo", async (broker) => {
        await broker.store(live());
        return broker.refresh("live", { fetch: stub.fetch });
      });

      expect(token).toBe("fresh");
      expect(stub.requests).toHaveLength(1);
    });

    it("joins concurrent 401 recoveries to the same rotation", async () => {
      const stub = wahooRefresh();

      const tokens = await withBroker("wahoo", async (broker) => {
        await broker.store(live());
        return Promise.all([
          broker.refresh("live", { fetch: stub.fetch }),
          broker.refresh("live", { fetch: stub.fetch }),
        ]);
      });

      expect(tokens).toEqual(["fresh", "fresh"]);
      expect(stub.requests).toHaveLength(1);
    });

    it("reports a rejected grant to every joined caller and retries later", async () => {
      const revoked = stubFetch(
        () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          }),
      );

      await withBroker("wahoo", async (broker) => {
        await broker.store(expired());
        const results = await Promise.allSettled([
          broker.accessToken({ fetch: revoked.fetch }),
          broker.accessToken({ fetch: revoked.fetch }),
        ]);
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      });
      expect(revoked.requests).toHaveLength(1);

      const recovered = wahooRefresh();
      const token = await withBroker("wahoo", (broker) =>
        broker.accessToken({ fetch: recovered.fetch }),
      );

      expect(token).toBe("fresh");
    });

    it("refreshes Strava against its own token endpoint", async () => {
      const stub = stubFetch(async (request) => {
        expect(request.url).toBe(STRAVA_TOKEN_URL);
        return Response.json({
          access_token: "fresh",
          refresh_token: "next-refresh",
          expires_at: nowS() + 21_600,
        });
      });

      const token = await withBroker("strava", async (broker) => {
        await broker.store(expired());
        return broker.accessToken({ fetch: stub.fetch });
      });

      expect(token).toBe("fresh");
      expect(stub.requests).toHaveLength(1);
    });
  });

  describe("store", () => {
    it("replaces the pair a later call reads", async () => {
      const state = await withBroker("wahoo", async (broker) => {
        await broker.store(live({ accessToken: "first" }));
        await broker.store(live({ accessToken: "second" }));
        return broker.current();
      });

      expect(state).toMatchObject({ accessToken: "second" });
    });

    it("survives eviction of the instance", async () => {
      await withBroker("wahoo", (broker) => broker.store(live()));

      expect(await brokerStub("wahoo").accessToken()).toBe("live");
    });
  });
});
