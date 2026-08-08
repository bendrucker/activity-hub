# Activity Hub

System of record for activity data (rides, workouts) from Strava and Wahoo. Ingests via webhooks, archives raw files in R2, and will build a DuckDB analytics lake that publishes a feed subset to [bendrucker.me](https://github.com/bendrucker/bendrucker.me). See the [README](README.md) for architecture and [docs/design.md](docs/design.md) for the full design.

## Stack

Cloudflare Workers (TypeScript), Bun, Wrangler. Storage: D1 (`REGISTRY`), R2 (`RAW`, `LAKE`), KV (`TOKENS`), Durable Objects (`TokenBroker`), Queues (`INGEST_QUEUE`). Config lives in `wrangler.jsonc`.

## Commands

- `bun run typecheck`: checks `src/` and `scripts/`
- `bun run test`: runs `vitest run` (uses `@cloudflare/vitest-pool-workers`, config in `vitest.config.ts`)
- `bun run format` / `bun run format:check`: Prettier
- `bun run dev`: runs `wrangler dev` for local iteration
- `bun run wrangler <cmd>`: pinned Wrangler binary. Use this over a global `wrangler` install
- `bun run types`: regenerates `worker-configuration.d.ts` from `wrangler.jsonc`

## Deploy

CI runs on every push and PR (`.github/workflows/ci.yml`): typecheck, test, format check. Deploy (`.github/workflows/deploy.yml`) triggers on push to `main`: applies D1 migrations, then `wrangler deploy`. Deploys are automatic; don't run `wrangler deploy` manually against production unless recovering from a broken deploy.

D1 migrations live in `migrations/`, applied with `wrangler d1 migrations apply`.

## Cloudflare configuration

Change Cloudflare resources (KV namespaces, R2 buckets, D1 databases, queues, cron triggers, secrets) through `wrangler.jsonc` plus the `wrangler` CLI, never through the Cloudflare dashboard. Dashboard edits drift from what's committed and get silently overwritten on the next deploy.

The Cloudflare HTTP API does support triggering scheduled/cron events and following prompts programmatically; don't assume it can't without checking the API docs first.

## Secrets

Worker secrets (`STRAVA_CLIENT_SECRET`, `WAHOO_CLIENT_ID`/`SECRET`, etc.) are set with `wrangler secret put`, never committed. Public, non-sensitive identifiers (client IDs, athlete IDs, API base URLs) are committed as `vars` in `wrangler.jsonc`. See the README's Secrets table for the full inventory and where each one is consumed.
