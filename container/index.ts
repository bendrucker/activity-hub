import { DuckDBInstance } from "@duckdb/node-api";
import { decodeTelemetry } from "../src/import/telemetry";
import { readConfig } from "./env";
import { configureS3 } from "./s3";
import { routes } from "./server";
import { stores } from "./storage";

const config = readConfig(Bun.env);
const { raw, lake } = stores(config);
const instance = await DuckDBInstance.create();

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8080),
  routes: routes({
    raw,
    lake,
    instance,
    decode: decodeTelemetry,
    configure: configureS3(config),
  }),
});

console.log(`transform container listening on ${server.url}`);
