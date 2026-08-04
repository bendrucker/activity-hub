export interface OAuthConfig {
  oauthBase: string;
  clientId: string;
  clientSecret: string;
}

export function oauthConfig(env: Env): OAuthConfig {
  if (!env.WAHOO_CLIENT_ID || !env.WAHOO_CLIENT_SECRET) {
    throw new Error(
      "WAHOO_CLIENT_ID / WAHOO_CLIENT_SECRET are not set. Run `wrangler secret put` for each.",
    );
  }
  return {
    oauthBase: env.WAHOO_OAUTH_BASE,
    clientId: env.WAHOO_CLIENT_ID,
    clientSecret: env.WAHOO_CLIENT_SECRET,
  };
}

export interface WahooTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export const TOKENS_KEY = "wahoo:tokens";

export async function readTokens(kv: KVNamespace): Promise<WahooTokens | null> {
  return kv.get<WahooTokens>(TOKENS_KEY, "json");
}

export async function writeTokens(
  kv: KVNamespace,
  tokens: WahooTokens,
): Promise<void> {
  await kv.put(TOKENS_KEY, JSON.stringify(tokens));
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at?: number;
}

async function requestToken(
  config: OAuthConfig,
  grant: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(`${config.oauthBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...grant,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Wahoo token request failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

// Wahoo reports lifetime as expires_in seconds from created_at, unlike
// Strava's absolute expires_at, so storage normalizes to an absolute epoch.
function toTokens(response: TokenResponse): WahooTokens {
  const issuedAt = response.created_at ?? Math.floor(Date.now() / 1000);
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: issuedAt + response.expires_in,
  };
}

// Wahoo requires redirect_uri on the exchange request too.
export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WahooTokens> {
  const response = await requestToken(
    config,
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    fetchImpl,
  );
  return toTokens(response);
}

export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WahooTokens> {
  const response = await requestToken(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
  );
  return toTokens(response);
}

// Wahoo rotates the refresh token on every refresh, so two invocations
// racing the same stored pair both send it and the loser gets invalid_grant
// even when the winner already persisted a working replacement. Re-reading
// the store separates that benign race from a truly revoked grant, which
// stays fatal and needs /auth/wahoo again.
export async function refreshStoredTokens(
  config: OAuthConfig,
  kv: KVNamespace,
  used: WahooTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<WahooTokens> {
  try {
    const fresh = await refreshTokens(config, used.refreshToken, fetchImpl);
    await writeTokens(kv, fresh);
    return fresh;
  } catch (error) {
    const current = await readTokens(kv);
    if (current && current.refreshToken !== used.refreshToken) {
      return current;
    }
    throw error;
  }
}

// Refresh this far before expiry so a token never dies mid-request chain.
export const REFRESH_MARGIN_S = 300;

// Wahoo rotates the refresh token on every refresh, so the fresh pair is
// persisted before the access token is handed out.
export async function accessToken(
  config: OAuthConfig,
  kv: KVNamespace,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const stored = await readTokens(kv);
  if (!stored) {
    throw new Error("no Wahoo tokens stored; authorize at /auth/wahoo");
  }
  if (stored.expiresAt - Date.now() / 1000 > REFRESH_MARGIN_S) {
    return stored.accessToken;
  }
  const fresh = await refreshStoredTokens(config, kv, stored, fetchImpl);
  return fresh.accessToken;
}
