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
  // R2 bindings do not cross into a container, so the decode container reaches
  // both buckets over the S3 API. The worker forwards these as its env vars,
  // which keeps the credentials out of the image and out of CI.
  R2_ACCOUNT_ID: string;
  R2_RAW_ACCESS_KEY_ID: string;
  R2_RAW_SECRET_ACCESS_KEY: string;
  R2_LAKE_ACCESS_KEY_ID: string;
  R2_LAKE_SECRET_ACCESS_KEY: string;
}
