# Source Constraints

Facts about the source APIs that shaped the design, current as of July 2026. Re-verify before building against any of them.

## Strava

#### Developer Program

- The June 2026 overhaul split the program into Standard (up to 10 connected athletes, automatic) and Extended Access (approval required). A single-user app fits Standard.
- Standard-tier developers must hold an active Strava subscription as of June 30, 2026. Already covered.
- Nothing athlete-personal was deprecated. The September 2026 cuts hit club endpoints and moved Segments Explore to Extended.
- June 2027 migration: auth tokens move to headers only and the base URL becomes `https://www.api-v3.strava.com`. Build with header auth and a configurable base URL from the start.
- The November 2024 agreement changes still apply: display only to the owning athlete, no AI/ML training on API data, no replicating Strava's look and feel. A single-user pipeline showing me my own data is the permitted case.

#### API Surface

- Rate limits: 200 requests/15 min and 2,000/day overall. Reads are 100/15 min and 1,000/day. Webhook deliveries don't count. Fetches do.
- Scope for a complete mirror: `activity:read_all` (includes private activities).
- Streams (`latlng`, `altitude`, `velocity_smooth`, `heartrate`, `cadence`, `watts`, `temperature`, `moving`, `grade_smooth`) remain fully retrievable for my own activities, including power.
- The API never returns original uploaded files. Streams are the closest thing. Original FIT files come only from bulk export or from Wahoo.
- Photos have no documented endpoint. `GET /activities/{id}/photos?size=5000&photo_sources=true` works, returns CDN URLs, and could break without notice. Full-resolution originals come only from bulk export.

#### Webhooks

- One subscription per app. Events fire for activity `create`/`update`/`delete` (update covers title, type, and privacy changes) and athlete deauthorization.
- Payload carries IDs only. The activity must be fetched afterward.
- The callback must echo `hub.challenge` on the validation GET and ack POSTs with a 200 within 2 seconds, or Strava retries (3 attempts total).

#### Bulk Export

- Settings → My Account → Download or Delete Your Account. The link arrives by email after a few hours.
- Contents: activities in original upload format (gzipped FIT for Wahoo-recorded rides, GPX/TCX otherwise), `activities.csv` with metadata richer than the API (weather, training load, grade-adjusted pace), full-resolution photos, routes, and profile JSON. Kudos and comments are not meaningfully included.
- No API or sanctioned automation exists for requesting exports. Session-cookie scripts violate the ToS. Treat export as a manual, occasional operation.
- The 2025 export analysis found 3,650 activities: 2,778 FIT, 535 GPX, 1 TCX, with `activities.csv` at 2.1 MB.

## Wahoo

#### Access

- Register at developers.wahooligan.com. Apps start in sandbox. Production requires human approval with a description of scopes and purpose.
- Sandbox rate limits: 25 req/5 min, 100/hour, 250/day. Production: 200/5 min, 1,000/hour, 5,000/day. Auth, token refresh, and file downloads are exempt.
- OAuth scopes: `user_read` is mandatory (403 without it), plus `workouts_read` and `offline_data`. The latter is required for refresh tokens and webhooks.

#### API Surface

- `GET /v1/workouts` paginates (30/page default) with no date filters. Backfill means paging to the end.
- Cloud history depth is undocumented. Workouts predating Wahoo Cloud sync may be absent. Verify by paging to the end against my account.
- `workout_summary` includes `file.url` pointing at the original FIT on `cdn.wahooligan.com`. This is the only API in the system that returns original device files.

#### Webhooks

- A `workout_summary` event POSTs to the configured URL when a workout syncs, with the FIT URL inline. A receiver archives the original file with zero additional API calls.
- Retries at 30 min, 4 h, 24 h, and 72 h on non-200. Duplicates are possible on file update or delete, so ingest must be idempotent.
- Only `workout_summary` is documented. No deauthorization or other event types.

## FIT Parsing

- Official Garmin SDKs: `@garmin/fitsdk` (pure JavaScript, runs in Workers) and `garmin-fit-sdk` (Python). Both actively released.
- `fitdecode` is the recommended community Python parser. `python-fitparse` is unmaintained.
- A DuckDB community extension `fit` exists (`INSTALL fit FROM community`) with `fit_records()`, `fit_sessions()`, `fit_laps()` table functions. Single maintainer. Vet developer-field coverage and note that gzipped `.fit.gz` from exports likely needs pre-decompression.
- GPX drops power. Power analysis must read from FIT (or TCX) files.

## Cloudflare

- Workers Paid: 30 s CPU default (configurable to 5 min), 128 MB memory, 100 MB request bodies. Fine for FIT parsing, rules out in-Worker DuckDB and uploading export archives through a Worker.
- R2: 10 GB storage free, zero egress. `httpfs` in DuckDB has a first-class R2 secret type.
- R2 Data Catalog: managed Iceberg REST catalog per bucket, beta, with managed compaction. Free tier covers 1M catalog ops and 10 GB compaction/month. DuckDB 1.5.3+ reads and writes it natively.
- R2 SQL: serverless SQL over Data Catalog tables, open beta. A candidate HTTP query surface for future agent features.
- Queues: available on the free plan (10k ops/day) since February 2026.
- R2 event notifications deliver `object-create`/`object-delete` to a Queue with prefix filters, if the transform trigger ever needs to be event-driven rather than cron.
