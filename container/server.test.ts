import { afterAll, beforeAll, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { TelemetryActivity } from "../src/import/telemetry";
import type { DecodeDeps } from "./decode";
import type { DecodeResponse } from "../src/transform/protocol";
import { routes } from "./server";
import type { LakeStore, RawStore } from "./storage";

let instance: DuckDBInstance;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  instance = await DuckDBInstance.create();
  server = Bun.serve({ port: 0, routes: routes(deps()) });
});

afterAll(async () => {
  await server.stop(true);
});

test("GET /health answers 200", async () => {
  const response = await fetch(new URL("/health", server.url));
  expect(response.status).toBe(200);
});

test("POST /decode answers an outcome per work item", async () => {
  const response = await post({
    work: [
      { activityId: "a", rawKeys: ["raw/a.fit.gz"] },
      { activityId: "b", rawKeys: ["raw/b.tcx.gz"] },
    ],
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as DecodeResponse;
  expect(body.outcomes.map((outcome) => outcome.status)).toEqual([
    "ok",
    "skipped",
  ]);
});

test("POST /decode rejects a body that is not a decode request", async () => {
  for (const body of [{}, { work: {} }, { work: [{ activityId: 1 }] }, []]) {
    expect((await post(body)).status).toBe(400);
  }
});

test("POST /decode rejects a body that is not JSON", async () => {
  const response = await fetch(new URL("/decode", server.url), {
    method: "POST",
    body: "{",
  });
  expect(response.status).toBe(400);
});

async function post(body: unknown): Promise<Response> {
  return fetch(new URL("/decode", server.url), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function deps(): DecodeDeps {
  const raw: RawStore = {
    async get(key) {
      return new TextEncoder().encode(key);
    },
  };
  const lake: LakeStore = {
    async put() {},
  };
  return { raw, lake, instance, decode: async () => activity() };
}

function activity(): TelemetryActivity {
  return {
    source: "gpx",
    records: [],
    laps: [],
    sessions: [],
    device: null,
    developerFields: [],
    errors: [],
  };
}
