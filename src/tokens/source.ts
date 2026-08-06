export type Provider = "wahoo" | "strava";

export interface OAuthConfig {
  oauthBase: string;
  clientId: string;
  clientSecret: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// The refresh token never leaves the broker, so callers see only what they
// need to decide whether the token they used is still the current one.
export interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export interface TokenSource {
  accessToken(): Promise<string>;
  refresh(used: string): Promise<string>;
  current(): Promise<TokenState | null>;
  store(tokens: StoredTokens): Promise<void>;
}

// Refresh this far before expiry so a token never dies mid-request chain.
export const REFRESH_MARGIN_S = 300;
