import type { DuckDBConnection } from "@duckdb/node-api";
import type { ContainerConfig, Credentials } from "./env";

export const RAW_BUCKET = "activity-hub-raw";
export const LAKE_BUCKET = "activity-hub-lake";

// The lake build reads thousands of Parquet files and writes a partitioned
// table, so DuckDB talks to R2 itself rather than having bytes streamed
// through the process. Decode keeps using Bun's client, which suits one
// whole-object read at a time.
export function configureS3(
  config: ContainerConfig,
): (connection: DuckDBConnection) => Promise<void> {
  return async (connection) => {
    await connection.run("LOAD httpfs");
    // The two buckets carry different credentials, and the raw one is
    // deliberately read-only.
    await connection.run(
      secret("raw", RAW_BUCKET, config.accountId, config.raw),
    );
    await connection.run(
      secret("lake", LAKE_BUCKET, config.accountId, config.lake),
    );
  };
}

function secret(
  name: string,
  bucket: string,
  accountId: string,
  credentials: Credentials,
): string {
  // R2 has no per-bucket subdomains, so path style is the only addressing that
  // resolves, and the endpoint carries no scheme.
  return `CREATE OR REPLACE SECRET ${name} (
    TYPE s3,
    PROVIDER config,
    KEY_ID ${literal(credentials.accessKeyId)},
    SECRET ${literal(credentials.secretAccessKey)},
    ENDPOINT ${literal(`${accountId}.r2.cloudflarestorage.com`)},
    URL_STYLE 'path',
    REGION 'auto',
    SCOPE ${literal(`s3://${bucket}`)}
  )`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
