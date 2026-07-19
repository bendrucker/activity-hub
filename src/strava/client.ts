import {
  type OAuthConfig,
  readTokens,
  refreshTokens,
  writeTokens,
} from "./oauth";

// Refresh this far before expiry so a token never dies mid-request chain.
export const REFRESH_MARGIN_S = 300;

export interface StravaClientConfig {
  apiBase: string;
  oauth: OAuthConfig;
  tokens: KVNamespace;
  fetchImpl?: typeof fetch;
}

export class StravaClient {
  constructor(private readonly config: StravaClientConfig) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    const fetchImpl = this.config.fetchImpl ?? fetch;
    return fetchImpl(`${this.config.apiBase}${path}`, { ...init, headers });
  }

  private async accessToken(): Promise<string> {
    const stored = await readTokens(this.config.tokens);
    if (!stored) {
      throw new Error("no Strava tokens stored; authorize at /auth/strava");
    }
    const now = Date.now() / 1000;
    if (stored.expiresAt - now > REFRESH_MARGIN_S) {
      return stored.accessToken;
    }
    const fresh = await refreshTokens(
      this.config.oauth,
      stored.refreshToken,
      this.config.fetchImpl ?? fetch,
    );
    await writeTokens(this.config.tokens, fresh);
    return fresh.accessToken;
  }
}
