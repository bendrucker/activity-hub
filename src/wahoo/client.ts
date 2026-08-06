import { tokenBroker } from "../tokens/broker";
import { REFRESH_MARGIN_S, type TokenSource } from "../tokens/source";

export interface WahooClientConfig {
  apiBase: string;
  tokens: TokenSource;
  fetchImpl?: typeof fetch;
}

export function wahooClient(env: Env): WahooClient {
  return new WahooClient({
    apiBase: env.WAHOO_API_BASE,
    tokens: tokenBroker(env, "wahoo"),
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
    const token = await this.config.tokens.accessToken();
    const response = await this.request(path, init, token);
    if (response.status !== 401) {
      return response;
    }
    const current = await this.config.tokens.current();
    const live =
      current?.accessToken === token &&
      current.expiresAt - Date.now() / 1000 > REFRESH_MARGIN_S;
    if (live) {
      // Wahoo answers 401 for individual workouts even on a live token
      // (observed in production, e.g. workout 481533297, whose body reads
      // "You are not authorized to view this workout summary"). Refreshing
      // on that quirk rotates the grant for nothing, so it belongs to the
      // caller. A revoked token names the token in its body ("Access token
      // has been revoked") and does need the refresh.
      const body = await response.clone().text();
      if (!/token/i.test(body)) {
        return response;
      }
    }
    return this.request(path, init, await this.config.tokens.refresh(token));
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
}
