import { tokenBroker } from "../tokens/broker";
import type { TokenSource } from "../tokens/source";

export interface StravaClientConfig {
  apiBase: string;
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
}

export function stravaClient(env: Env): StravaClient {
  return new StravaClient({
    apiBase: env.STRAVA_API_BASE,
    tokens: tokenBroker(env, "strava"),
  });
}

export class StravaClient {
  private readonly transport: typeof globalThis.fetch;

  constructor(private readonly config: StravaClientConfig) {
    // workerd's native fetch throws "Illegal invocation" when called with a
    // foreign `this`. An arrow wrapper keeps late binding without that risk.
    this.transport = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.config.tokens.accessToken();
    const response = await this.request(path, init, token);
    if (response.status !== 401) {
      return response;
    }
    // A 401 before recorded expiry means the token was revoked early.
    return this.request(path, init, await this.config.tokens.refresh(token));
  }

  private request(path: string, init: RequestInit, accessToken: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return this.transport(`${this.config.apiBase}${path}`, {
      ...init,
      headers,
    });
  }
}
