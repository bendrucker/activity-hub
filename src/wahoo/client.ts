import {
  accessToken,
  oauthConfig,
  readTokens,
  refreshStoredTokens,
  REFRESH_MARGIN_S,
  type OAuthConfig,
} from "./oauth";

export interface WahooClientConfig {
  apiBase: string;
  oauth: OAuthConfig;
  tokens: KVNamespace;
  fetchImpl?: typeof fetch;
}

export function wahooClient(env: Env): WahooClient {
  return new WahooClient({
    apiBase: env.WAHOO_API_BASE,
    oauth: oauthConfig(env),
    tokens: env.TOKENS,
  });
}

export class WahooClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: WahooClientConfig) {
    // workerd's native fetch throws "Illegal invocation" when called with a
    // foreign `this`. An arrow wrapper keeps late binding without that risk.
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await accessToken(
      this.config.oauth,
      this.config.tokens,
      this.fetchImpl,
    );
    const response = await this.request(path, init, token);
    if (response.status !== 401) {
      return response;
    }
    const stored = await readTokens(this.config.tokens);
    if (stored && stored.accessToken !== token) {
      // Another invocation rotated the pair mid-flight and the rotation
      // killed the token this request went out with. The replacement is
      // already stored, so use it rather than refreshing again.
      return this.request(path, init, stored.accessToken);
    }
    if (stored && stored.expiresAt - Date.now() / 1000 > REFRESH_MARGIN_S) {
      // Wahoo answers 401 for individual workouts even on a live token
      // (observed in production, e.g. workout 481533297, whose body reads
      // "You are not authorized to view this workout summary"). Refreshing
      // on that quirk rotates the grant for nothing and races every
      // concurrent invocation into reuse revocation, so it belongs to the
      // caller. A revoked token names the token in its body
      // ("Access token has been revoked") and does need the refresh.
      const body = await response.clone().text();
      if (!/token/i.test(body)) {
        return response;
      }
    }
    return this.request(path, init, await this.refresh());
  }

  private request(
    path: string,
    init: RequestInit,
    token: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return this.fetchImpl(`${this.config.apiBase}${path}`, {
      ...init,
      headers,
    });
  }

  private async refresh(): Promise<string> {
    const stored = await readTokens(this.config.tokens);
    if (!stored) {
      throw new Error("no Wahoo tokens stored; authorize at /auth/wahoo");
    }
    const fresh = await refreshStoredTokens(
      this.config.oauth,
      this.config.tokens,
      stored,
      this.fetchImpl,
    );
    return fresh.accessToken;
  }
}
