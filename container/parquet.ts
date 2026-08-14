import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { TelemetryActivity } from "../src/import/telemetry";
import {
  appendRows,
  createTableSql,
  metaRows,
  LAPS,
  META,
  RECORDS,
  SESSIONS,
  type Table,
} from "./schema";

export interface ParquetFile {
  name: string;
  path: string;
}

// One connection per activity. Tables are temporary, so their names live in
// that connection's own schema and two activities in flight cannot collide.
export async function writeActivityParquet(
  instance: DuckDBInstance,
  directory: string,
  activityId: string,
  rawKey: string,
  activity: TelemetryActivity,
): Promise<ParquetFile[]> {
  const connection = await instance.connect();
  try {
    return [
      await writeTable(
        connection,
        directory,
        activityId,
        RECORDS,
        activity.records,
      ),
      await writeTable(connection, directory, activityId, LAPS, activity.laps),
      await writeTable(
        connection,
        directory,
        activityId,
        SESSIONS,
        activity.sessions,
      ),
      await writeTable(
        connection,
        directory,
        activityId,
        META,
        metaRows(activity, rawKey),
      ),
    ];
  } finally {
    connection.disconnectSync();
  }
}

async function writeTable<R extends object>(
  connection: DuckDBConnection,
  directory: string,
  activityId: string,
  table: Table<R>,
  rows: readonly R[],
): Promise<ParquetFile> {
  await connection.run(createTableSql(table));

  const appender = await connection.createAppender(table.name);
  try {
    appendRows(appender, table, activityId, rows);
    appender.flushSync();
  } finally {
    appender.closeSync();
  }

  const name = `${table.name}.parquet`;
  const path = `${directory}/${name}`;
  await connection.run(
    `COPY (SELECT * FROM "${table.name}") TO ${literal(path)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );
  return { name, path };
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
