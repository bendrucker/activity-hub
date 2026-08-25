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

// Sleeping the container is a SIGTERM and nothing else: @cloudflare/containers
// never follows it with a SIGKILL. Bun runs as PID 1 here, and the kernel
// applies no default disposition to PID 1, so an unhandled SIGTERM is
// discarded and the instance runs until the platform reaps it. Memory and disk
// bill on wall clock, so that idle instance costs ~$1.37 a day.
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});

console.log(`transform container listening on ${server.url}`);
