import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type {
  LakeRequest,
  LakeResponse,
  LakeTableResult,
} from "../src/transform/protocol";
import { TABLES, type LakeSources, type LakeTable } from "./tables";

export interface LakeDeps {
  instance: DuckDBInstance;
  // Applied to the connection before any query runs, so a test can point the
  // same SQL at local files by supplying nothing.
  configure?: (connection: DuckDBConnection) => Promise<void>;
}

// Rebuilds every table from scratch on every run. A full rebuild is two
// minutes over the whole corpus, which is cheaper than the bookkeeping an
// incremental merge would need to stay correct across upstream edits.
export async function buildLake(
  request: LakeRequest,
  deps: LakeDeps,
): Promise<LakeResponse> {
  const connection = await deps.instance.connect();
  try {
    await deps.configure?.(connection);

    const sources: LakeSources = {
      decode: trimSlash(request.decode),
      registry: request.registry,
      stravaExport: request.stravaExport,
      decoded: await anyDecoded(connection, trimSlash(request.decode)),
    };

    const tables: LakeTableResult[] = [];
    for (const table of TABLES) {
      tables.push(await buildTable(connection, table, sources, request.output));
    }
    return { outputKey: request.output, tables };
  } finally {
    connection.disconnectSync();
  }
}

// glob() answers with a row per match and no rows when nothing matches, which
// is the one way to ask the question that a missing prefix does not turn into
// an error.
async function anyDecoded(
  connection: DuckDBConnection,
  decode: string,
): Promise<boolean> {
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) AS files FROM glob(${literal(`${decode}/*/records.parquet`)})`,
  );
  const [row] = reader.getRowObjects();
  return Number(row?.files ?? 0) > 0;
}

async function buildTable(
  connection: DuckDBConnection,
  table: LakeTable,
  sources: LakeSources,
  output: string,
): Promise<LakeTableResult> {
  const destination = `${trimSlash(output)}/${table.name}`;
  const options = [
    "FORMAT PARQUET",
    "COMPRESSION ZSTD",
    // The whole table is rewritten each run, so last run's files have to go or
    // a shrinking table would keep serving rows it no longer contains.
    "OVERWRITE_OR_IGNORE true",
    "FILENAME_PATTERN 'part_{i}'",
  ];
  // COPY writes a single file unless something forces multi-file output, and
  // an unpartitioned table would then land as a file where the partitioned
  // ones are directories. Per-thread output makes every table a directory, so
  // one glob reads them all and adding a partition key later moves no paths.
  options.push(
    table.partitionBy === undefined
      ? "PER_THREAD_OUTPUT true"
      : `PARTITION_BY (${table.partitionBy})`,
  );

  // COPY answers with the row count it wrote. Counting by reading the output
  // back would run the whole query twice and, for a table that came out empty,
  // would glob a directory COPY never created.
  const reader = await connection.runAndReadAll(
    `COPY (${table.sql(sources)}) TO ${literal(destination)} (${options.join(", ")})`,
  );
  const [row] = reader.getRowObjects();
  return { name: table.name, rows: Number(row?.Count ?? 0) };
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
