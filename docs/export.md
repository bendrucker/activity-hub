# Strava Bulk Export

Procedure for requesting a Strava bulk export and staging it in the raw bucket. The export is the canonical history and the only source of original FIT files and full-resolution photos, so the procedure runs occasionally (new photo backstop, pre-migration snapshot), not on a schedule.

## Requesting

1. Strava web: Settings → My Account → Download or Delete Your Account → "Request Your Archive" (step 1, not the account-deletion step).
2. The archive link arrives by email within a few hours. The 2026 link was a presigned S3 URL that worked without a Strava login and expired a week after issue, so download promptly. The filename embeds the athlete ID (`export_5723594.zip`).
3. Download and verify:

```sh
mkdir -p tmp
curl -sS -o tmp/export_5723594.zip '<presigned url>'
unzip -t tmp/export_5723594.zip
```

## Staging

Unpack locally, then sync the tree to `raw/strava/export/{date}/` in the `activity-hub-raw` bucket, named for the export request date:

```sh
unzip -q tmp/export_5723594.zip -d tmp/export/2026-07-16
aws s3 sync tmp/export/2026-07-16/ s3://activity-hub-raw/raw/strava/export/2026-07-16/ \
  --endpoint-url https://72bdc77341dc52a3cf4a94097f9ad96f.r2.cloudflarestorage.com \
  --checksum-algorithm CRC32
```

`aws s3 sync` reads an R2 API token from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (Object Read & Write on `activity-hub-raw`; no `--region` needed, R2 treats it as `auto`). `--checksum-algorithm CRC32` avoids the newer CLI default checksums that R2 rejects. Without a token, `wrangler r2 object put` under an OAuth login works one object at a time. That path takes hours for a ~3,900-object export, so mint a token for anything but a spot fix.

Confirm the sync landed completely by comparing object counts:

```sh
find tmp/export/2026-07-16 -type f | wc -l
aws s3 ls --recursive s3://activity-hub-raw/raw/strava/export/2026-07-16/ \
  --endpoint-url https://72bdc77341dc52a3cf4a94097f9ad96f.r2.cloudflarestorage.com | wc -l
```

The export stages as-is: original bytes, original archive layout, gzipped FIT files left gzipped. The [importer](design.md#backfill) reads from the local unpacked tree, places per-activity copies under `raw/strava/activities/{id}/`, and writes the registry. The `export/{date}/` prefix is the immutable record of what Strava returned.

## Contents

The 2026-07-16 export (698 MB zipped, 876 MB unpacked) held:

- `activities.csv`: 4,118 rows, one per activity, with metadata richer than the API returns (weather, training load, grade-adjusted pace). 297 rows have no file (manual and trainer entries).
- `activities/`: 3,821 original upload files (3,245 `.fit.gz`, 536 `.gpx`, 38 `.gpx.gz`, 1 `.tcx.gz`, 1 bare `.fit`). Filenames are upload IDs. The CSV `Filename` column maps each activity ID to its file.
- `media/`: 49 full-resolution photos with UUID filenames. The CSV `Media` column names a photo on 1,487 activity rows, so most referenced media is missing from the archive.
- Account CSVs: profile, gear, routes, segments, followers. Nothing downstream consumes these yet.
