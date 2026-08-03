import {
  accessToken,
  oauthConfig,
  readTokens,
  refreshTokens,
  writeTokens,
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
    // A 401 before recorded expiry means the token was revoked early.
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
    const fresh = await refreshTokens(
      this.config.oauth,
      stored.refreshToken,
      this.fetchImpl,
    );
    await writeTokens(this.config.tokens, fresh);
    return fresh.accessToken;
  }
}
