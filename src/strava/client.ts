import {
  oauthConfig,
  readTokens,
  refreshTokens,
  writeTokens,
  type OAuthConfig,
  type StravaTokens,
} from "./oauth";

// Refresh this far before expiry so a token never dies mid-request chain.
export const REFRESH_MARGIN_S = 300;

export interface StravaClientConfig {
  apiBase: string;
  oauth: OAuthConfig;
  tokens: KVNamespace;
  fetchImpl?: typeof fetch;
}

export function stravaClient(env: Env): StravaClient {
  return new StravaClient({
    apiBase: env.STRAVA_API_BASE,
    oauth: oauthConfig(env),
    tokens: env.TOKENS,
  });
}

export class StravaClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: StravaClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.request(path, init, await this.accessToken());
    if (response.status !== 401) {
      return response;
    }
    // A 401 before recorded expiry means the token was revoked early.
    return this.request(path, init, await this.refresh());
  }

  private request(
    path: string,
    init: RequestInit,
    accessToken: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return this.fetchImpl(`${this.config.apiBase}${path}`, {
      ...init,
      headers,
    });
  }

  private async accessToken(): Promise<string> {
    const stored = await this.storedTokens();
    const now = Date.now() / 1000;
    if (stored.expiresAt - now > REFRESH_MARGIN_S) {
      return stored.accessToken;
    }
    return this.refresh(stored);
  }

  private async refresh(stored?: StravaTokens): Promise<string> {
    stored ??= await this.storedTokens();
    const fresh = await refreshTokens(
      this.config.oauth,
      stored.refreshToken,
      this.fetchImpl,
    );
    await writeTokens(this.config.tokens, fresh);
    return fresh.accessToken;
  }

  private async storedTokens(): Promise<StravaTokens> {
    const stored = await readTokens(this.config.tokens);
    if (!stored) {
      throw new Error("no Strava tokens stored; authorize at /auth/strava");
    }
    return stored;
  }
}
