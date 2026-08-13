import { DuckDBInstance } from "@duckdb/node-api";
import { decodeTelemetry } from "../src/import/telemetry";
import { readConfig } from "./env";
import { routes } from "./server";
import { stores } from "./storage";

const config = readConfig(Bun.env);
const { raw, lake } = stores(config);
const instance = await DuckDBInstance.create();

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8080),
  routes: routes({ raw, lake, instance, decode: decodeTelemetry }),
});

console.log(`decode container listening on ${server.url}`);
