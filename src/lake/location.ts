// Where the buckets live, spelled as URIs. Bindings do not cross into the
// container, so every location the Worker hands it is an S3 URI rather than a
// key, and the bucket names appear here and nowhere else.

export const RAW_BUCKET = "activity-hub-raw";
export const LAKE_BUCKET = "activity-hub-lake";

export const DECODE_PREFIX = "decode/v1";
export const OUTPUT_PREFIX = "lake/v1";

export function rawUri(key: string): string {
  return uri(RAW_BUCKET, key);
}

export function lakeUri(key: string): string {
  return uri(LAKE_BUCKET, key);
}

function uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}
