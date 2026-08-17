import { lakeClient, type LakeClient } from "../transform/container";
import type { LakeResponse } from "../transform/protocol";
import { DECODE_PREFIX, lakeUri, OUTPUT_PREFIX, rawUri } from "./location";
import { exportRegistry, type RegistrySnapshot } from "./registry";

// Matches the second entry in wrangler.jsonc's crons. The scheduled handler
// serves both triggers and tells them apart by this expression, so the two
// have to stay in step.
export const LAKE_CRON = "0 8 * * *";

const EXPORT_PREFIX = "raw/strava/export/";
const EXPORT_CSV = "activities.csv";

export interface LakeBuildOptions {
  client?: LakeClient;
}

export interface LakeBuildResult {
  registry: RegistrySnapshot;
  stravaExport: string | null;
  response: LakeResponse;
}

// This is the whole stage: there is no per-activity unit, because a table is
// only consistent once every activity in it came from the same rebuild.
export async function buildLake(
  env: Env,
  options: LakeBuildOptions = {},
): Promise<LakeBuildResult> {
  const [registry, stravaExport] = await Promise.all([
    exportRegistry(env.REGISTRY, env.LAKE),
    latestExportCsv(env.RAW),
  ]);

  const client = options.client ?? lakeClient(env);
  const response = await client.build({
    decode: lakeUri(DECODE_PREFIX),
    registry: lakeUri(registry.key),
    stravaExport: stravaExport === null ? null : rawUri(stravaExport),
    output: lakeUri(OUTPUT_PREFIX),
  });

  return { registry, stravaExport, response };
}

// Exports are archived under a dated prefix and each one supersedes the last,
// so the newest is the only one whose numbers should reach the lake. Listing
// delimited by prefix returns the dates without walking thousands of activity
// files.
export async function latestExportCsv(
  bucket: R2Bucket,
): Promise<string | null> {
  const listed = await bucket.list({
    prefix: EXPORT_PREFIX,
    delimiter: "/",
  });
  const latest = [...listed.delimitedPrefixes].sort().pop();
  if (latest === undefined) {
    return null;
  }

  const key = `${latest}${EXPORT_CSV}`;
  // An export whose CSV never uploaded would otherwise fail the whole build
  // inside DuckDB, where the error names a URI rather than a missing archive.
  return (await bucket.head(key)) === null ? null : key;
}
