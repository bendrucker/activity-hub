import { DuckDBInstance } from "@duckdb/node-api";
import { decodeTelemetry } from "../src/import/telemetry";
import { LAKE_BUILD_SUMMARY_KEY } from "../src/transform/protocol";
import { readConfig } from "./env";
import { buildLake } from "./lake";
import { lakeRunner } from "./lake-runner";
import { configureS3 } from "./s3";
import { routes } from "./server";
import { stores } from "./storage";

const config = readConfig(Bun.env);
const { raw, lake } = stores(config);
const instance = await DuckDBInstance.create();
const configure = configureS3(config);

const runner = lakeRunner({
  build: (request) => buildLake(request, { instance, configure }),
  save: (summary) => lake.putJson(LAKE_BUILD_SUMMARY_KEY, summary),
  exit: shutdown,
});

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8080),
  routes: routes({
    raw,
    lake,
    instance,
    decode: decodeTelemetry,
    configure,
    runner,
  }),
});

function shutdown(): void {
  server.stop(true);
  process.exit(0);
}

// Sleeping the container is a SIGTERM and nothing else: @cloudflare/containers
// never follows it with a SIGKILL. Bun runs as PID 1 here, and the kernel
// applies no default disposition to PID 1, so an unhandled SIGTERM is
// discarded and the instance runs until the platform reaps it. Memory and disk
// bill on wall clock, so that idle instance costs ~$1.37 a day.
//
// A running lake build defers the exit instead of dying mid-write: the library
// re-sends SIGTERM every couple of minutes, so the drain has to be idempotent,
// and the runner exits the process itself once the build settles. A platform
// stop (a deploy) escalates to SIGKILL after 15 minutes and kills a mid-build;
// the next nightly heals it.
process.on("SIGTERM", () => {
  if (runner.drain()) {
    return;
  }
  shutdown();
});

console.log(`transform container listening on ${server.url}`);
