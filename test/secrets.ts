// Secrets are set with `wrangler secret put` in production, so wrangler.jsonc
// declares none and the test config binds these instead. The Durable Object
// reads them off its own env, which only a binding can reach.
export const SECRETS = {
  ADMIN_TOKEN: "admin-secret",
  STRAVA_CLIENT_SECRET: "shh",
  STRAVA_VERIFY_TOKEN: "verify-me",
  WAHOO_CLIENT_ID: "2348",
  WAHOO_CLIENT_SECRET: "wahoo-shh",
  WAHOO_WEBHOOK_TOKEN: "hook-token",
} satisfies Partial<Env>;
