import { DurableObject } from "cloudflare:workers";
import {
  oauthConfig as stravaOAuthConfig,
  readTokens as readStravaTokens,
  refreshTokens as refreshStravaTokens,
  writeTokens as writeStravaTokens,
} from "../strava/oauth";
import {
  oauthConfig as wahooOAuthConfig,
  readTokens as readWahooTokens,
  refreshTokens as refreshWahooTokens,
  writeTokens as writeWahooTokens,
} from "../wahoo/oauth";
import {
  REFRESH_MARGIN_S,
  type OAuthConfig,
  type Provider,
  type StoredTokens,
  type TokenSource,
  type TokenState,
} from "./source";

interface ProviderBinding {
  label: string;
  authPath: string;
  config(env: Env): OAuthConfig;
  // Tokens predate the broker and still live in KV until the first call
  // adopts them. Without this the deploy would need a re-authorization.
  seed(kv: KVNamespace): Promise<StoredTokens | null>;
  mirror(kv: KVNamespace, tokens: StoredTokens): Promise<void>;
  refresh(
    config: OAuthConfig,
    refreshToken: string,
    fetch?: typeof globalThis.fetch,
  ): Promise<StoredTokens>;
}

const PROVIDERS: Record<Provider, ProviderBinding> = {
  wahoo: {
    label: "Wahoo",
    authPath: "/auth/wahoo",
    config: wahooOAuthConfig,
    seed: readWahooTokens,
    mirror: writeWahooTokens,
    refresh: refreshWahooTokens,
  },
  strava: {
    label: "Strava",
    authPath: "/auth/strava",
    config: stravaOAuthConfig,
    seed: readStravaTokens,
    mirror: writeStravaTokens,
    refresh: refreshStravaTokens,
  },
};

function isProvider(name: string | undefined): name is Provider {
  return name === "wahoo" || name === "strava";
}

const STORAGE_KEY = "tokens";

export interface BrokerOptions {
  fetch?: typeof globalThis.fetch;
}

// One instance per provider serializes every refresh for that grant. Wahoo
// rotates the refresh token on each refresh and revokes the whole grant when
// it sees one reused, which two invocations racing a KV read reliably
// produce: KV reads go up to 60 seconds stale, so both send the same pair.
export class TokenBroker extends DurableObject<Env> {
  private rotating: Promise<StoredTokens> | null = null;

  async accessToken(options: BrokerOptions = {}): Promise<string> {
    const stored = await this.requireTokens();
    if (stored.expiresAt - Date.now() / 1000 > REFRESH_MARGIN_S) {
      return stored.accessToken;
    }
    const fresh = await this.rotate(options);
    return fresh.accessToken;
  }

  // `used` is the access token whose request failed. A different one in
  // storage means the grant already rotated past it, so handing that back
  // spends no refresh.
  async refresh(used: string, options: BrokerOptions = {}): Promise<string> {
    const stored = await this.requireTokens();
    if (stored.accessToken !== used) {
      return stored.accessToken;
    }
    const fresh = await this.rotate(options);
    return fresh.accessToken;
  }

  async current(): Promise<TokenState | null> {
    const stored = await this.load();
    if (!stored) {
      return null;
    }
    return { accessToken: stored.accessToken, expiresAt: stored.expiresAt };
  }

  async store(tokens: StoredTokens): Promise<void> {
    await this.persist(tokens);
    await this.mirror(tokens);
  }

  private get provider(): ProviderBinding {
    const name = this.ctx.id.name;
    if (!isProvider(name)) {
      throw new Error(`TokenBroker addressed by ${name ?? "an unnamed id"}`);
    }
    return PROVIDERS[name];
  }

  private persist(tokens: StoredTokens): Promise<void> {
    return this.ctx.storage.put(STORAGE_KEY, tokens);
  }

  // Rollback insurance. Nothing reads this copy while the broker is
  // deployed, but the code it replaced refreshes straight from KV. Left
  // holding a pair the broker already spent, that code would send a used
  // refresh token, and Wahoo revokes the whole grant when it sees one, which
  // only a manual re-authorization recovers.
  private async mirror(tokens: StoredTokens): Promise<void> {
    try {
      await this.provider.mirror(this.env.TOKENS, tokens);
    } catch (error) {
      // A shadow that falls behind costs a re-authorization only if we also
      // roll back. Failing the refresh costs one now.
      console.warn(`token mirror to KV failed: ${String(error)}`);
    }
  }

  private async load(): Promise<StoredTokens | null> {
    const stored = await this.ctx.storage.get<StoredTokens>(STORAGE_KEY);
    if (stored) {
      return stored;
    }
    const seeded = await this.provider.seed(this.env.TOKENS);
    if (seeded) {
      await this.persist(seeded);
    }
    return seeded;
  }

  private async requireTokens(): Promise<StoredTokens> {
    const stored = await this.load();
    if (!stored) {
      const { label, authPath } = this.provider;
      throw new Error(`no ${label} tokens stored; authorize at ${authPath}`);
    }
    return stored;
  }

  // Input gating serializes calls until one awaits the network, so the
  // refresh request itself needs its own gate: everyone who arrives while it
  // is out joins it and gets the pair it stored.
  private rotate(options: BrokerOptions): Promise<StoredTokens> {
    if (this.rotating) {
      return this.rotating;
    }
    const rotating = this.exchange(options).finally(() => {
      if (this.rotating === rotating) {
        this.rotating = null;
      }
    });
    this.rotating = rotating;
    return rotating;
  }

  private async exchange(options: BrokerOptions): Promise<StoredTokens> {
    const stored = await this.requireTokens();
    const provider = this.provider;
    const fresh = await provider.refresh(
      provider.config(this.env),
      stored.refreshToken,
      options.fetch,
    );
    await this.store(fresh);
    return fresh;
  }
}

export function tokenBroker(
  env: Pick<Env, "TOKEN_BROKER">,
  provider: Provider,
): TokenSource {
  const namespace = env.TOKEN_BROKER;
  const stub = namespace.get(namespace.idFromName(provider));
  return {
    accessToken: () => stub.accessToken(),
    refresh: (used) => stub.refresh(used),
    current: () => stub.current(),
    store: (tokens) => stub.store(tokens),
  };
}
