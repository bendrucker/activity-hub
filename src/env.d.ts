// Secrets are set with `wrangler secret put` and never appear in
// wrangler.jsonc, so `wrangler types` cannot generate them.
interface Env {
  STRAVA_CLIENT_SECRET: string;
  STRAVA_VERIFY_TOKEN: string;
}
