// Runs the lake build against R2 itself, using the same credentials the
// container gets. The local corpus harness proves the SQL. This proves DuckDB
// can read a decode tree and write a partitioned table over S3, which is the
// only part of the stage that a local run cannot exercise.
//
// Point --output at a scratch prefix. Every table it writes is overwritten in
// place, so aiming it at the live prefix would replace the nightly build with
// whatever subset of activities happens to be decoded right now.
import { DuckDBInstance } from "@duckdb/node-api";
import { buildLake } from "./lake";
import { readConfig } from "./env";
import { configureS3, LAKE_BUCKET, RAW_BUCKET } from "./s3";

const [decode, registry, stravaExport, output] = process.argv.slice(2);
if (!decode || !registry || !output) {
  throw new Error(
    "usage: verify-r2.ts <decode-uri> <registry-uri> <export-uri|-> <output-uri>",
  );
}

const instance = await DuckDBInstance.create(":memory:");
const response = await buildLake(
  {
    decode,
    registry,
    stravaExport: stravaExport === "-" ? null : stravaExport,
    output,
  },
  { instance, configure: configureS3(readConfig(process.env)) },
);
console.log(JSON.stringify(response, null, 2));

const connection = await instance.connect();
await configureS3(readConfig(process.env))(connection);
const reader = await connection.runAndReadAll(
  `SELECT telemetry_origin, telemetry_format, power_source, COUNT(*) AS activities
   FROM read_parquet('${output.replace(/\/$/, "")}/activities/**/*.parquet')
   GROUP BY ALL ORDER BY activities DESC`,
);
console.log(
  JSON.stringify(
    reader.getRowObjects(),
    (_, value) => (typeof value === "bigint" ? Number(value) : value),
    2,
  ),
);
console.log(`read ${RAW_BUCKET} and wrote ${LAKE_BUCKET}`);
