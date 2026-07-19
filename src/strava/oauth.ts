export interface OAuthConfig {
  oauthBase: string;
  clientId: string;
  clientSecret: string;
}

export function oauthConfig(env: Env): OAuthConfig {
  if (!env.STRAVA_CLIENT_SECRET) {
    throw new Error(
      "STRAVA_CLIENT_SECRET is not set. Run `wrangler secret put STRAVA_CLIENT_SECRET`.",
    );
  }
  return {
    oauthBase: env.STRAVA_OAUTH_BASE,
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
  };
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export const TOKENS_KEY = "strava:tokens";

export async function readTokens(
  kv: KVNamespace,
): Promise<StravaTokens | null> {
  return kv.get<StravaTokens>(TOKENS_KEY, "json");
}

export async function writeTokens(
  kv: KVNamespace,
  tokens: StravaTokens,
): Promise<void> {
  await kv.put(TOKENS_KEY, JSON.stringify(tokens));
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number };
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
      `Strava token request failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

function toTokens(response: TokenResponse): StravaTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: response.expires_at,
  };
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: StravaTokens; athleteId: number | undefined }> {
  const response = await requestToken(
    config,
    { grant_type: "authorization_code", code },
    fetchImpl,
  );
  return { tokens: toTokens(response), athleteId: response.athlete?.id };
}

export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StravaTokens> {
  const response = await requestToken(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
  );
  return toTokens(response);
}
