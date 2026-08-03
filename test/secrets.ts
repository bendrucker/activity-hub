// Secrets are set with `wrangler secret put` in production, so miniflare has
// no bindings for them and tests fill them in.
export const SECRETS = {
  ADMIN_TOKEN: "admin-secret",
  STRAVA_CLIENT_SECRET: "shh",
  STRAVA_VERIFY_TOKEN: "verify-me",
  WAHOO_CLIENT_ID: "2348",
  WAHOO_CLIENT_SECRET: "wahoo-shh",
  WAHOO_WEBHOOK_TOKEN: "hook-token",
} satisfies Partial<Env>;
