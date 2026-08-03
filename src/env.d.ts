// Secrets are set with `wrangler secret put` and never appear in
// wrangler.jsonc, so `wrangler types` cannot generate them.
interface Env {
  ADMIN_TOKEN: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_VERIFY_TOKEN: string;
  // Wahoo does not publish app client ids, so unlike Strava's committed var
  // the id lives alongside the secret (see the README secrets table).
  WAHOO_CLIENT_ID: string;
  WAHOO_CLIENT_SECRET: string;
  WAHOO_WEBHOOK_TOKEN: string;
}
