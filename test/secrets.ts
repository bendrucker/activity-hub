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
  // Only ever forwarded to the container, which no test starts. They exist
  // here so an Env literal typechecks.
  R2_ACCOUNT_ID: "account",
  R2_RAW_ACCESS_KEY_ID: "raw-key",
  R2_RAW_SECRET_ACCESS_KEY: "raw-secret",
  R2_LAKE_ACCESS_KEY_ID: "lake-key",
  R2_LAKE_SECRET_ACCESS_KEY: "lake-secret",
} satisfies Partial<Env>;
