import { expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { ContainerConfig } from "./env";
import { configureS3 } from "./s3";

const config: ContainerConfig = {
  accountId: "acct",
  raw: { accessKeyId: "raw-key", secretAccessKey: "raw-secret" },
  lake: { accessKeyId: "lake-key", secretAccessKey: "lake-secret" },
};

// Records the statements a connection was asked to run. The secret definitions
// are the ones that matter, so they are what the assertions count.
function recorder(): { connection: DuckDBConnection; statements: string[] } {
  const statements: string[] = [];
  const connection = {
    run: async (sql: string) => {
      statements.push(sql);
      await Promise.resolve();
    },
  } as unknown as DuckDBConnection;
  return { connection, statements };
}

function secretsIn(statements: string[]): string[] {
  return statements.filter((sql) => sql.includes("CREATE OR REPLACE SECRET"));
}

test("defines both secrets on the first connection", async () => {
  const configure = configureS3(config);
  const { connection, statements } = recorder();

  await configure(connection);

  expect(statements[0]).toBe("LOAD httpfs");
  expect(statements).toContain("SET threads = 16");
  expect(statements).toContain("SET enable_object_cache = true");
  expect(secretsIn(statements)).toHaveLength(2);
  expect(statements.join("\n")).toContain("s3://activity-hub-raw");
  expect(statements.join("\n")).toContain("s3://activity-hub-lake");
});

// Secrets live on the instance, so redefining them per request races every
// other request against the same catalog entry.
test("defines the secrets once across concurrent connections", async () => {
  const configure = configureS3(config);
  const recorders = Array.from({ length: 8 }, () => recorder());

  await Promise.all(recorders.map(({ connection }) => configure(connection)));

  const defined = recorders.flatMap(({ statements }) => secretsIn(statements));
  expect(defined).toHaveLength(2);
  // Every connection still loads the extension it reads R2 through.
  for (const { statements } of recorders) {
    expect(statements).toContain("LOAD httpfs");
  }
});

test("a failed definition lets the next connection try again", async () => {
  const configure = configureS3(config);
  const failing = {
    run: async (sql: string) => {
      await Promise.resolve();
      if (sql.includes("CREATE OR REPLACE SECRET")) {
        throw new Error("catalog conflict");
      }
    },
  } as unknown as DuckDBConnection;

  await expect(configure(failing)).rejects.toThrow("catalog conflict");

  const { connection, statements } = recorder();
  await configure(connection);
  expect(secretsIn(statements)).toHaveLength(2);
});
