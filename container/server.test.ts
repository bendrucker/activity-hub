import { afterAll, beforeAll, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { TelemetryActivity } from "../src/import/telemetry";
import type { DecodeDeps } from "./decode";
import { lakeRunner, type LakeRunner } from "./lake-runner";
import type {
  DecodeResponse,
  LakeRequest,
  LakeStart,
} from "../src/transform/protocol";
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

// The route answers before the build settles, so a build parked on a promise
// only this test can resolve proves the 202 is an accept rather than a result,
// and holds the runner busy for the 409 alongside it.
test("POST /lake accepts before the build settles and refuses a second", async () => {
  const settled = Promise.withResolvers<{ tables: [] }>();
  const runner = lakeRunner({
    build: () => settled.promise,
    save: async () => {},
    exit: () => {},
  });
  const lakeServer = Bun.serve({ port: 0, routes: routes(deps(runner)) });
  try {
    const first = await postLake(lakeServer);
    expect(first.status).toBe(202);
    const start = (await first.json()) as LakeStart;
    expect(start.accepted).toBe(true);

    const second = await postLake(lakeServer);
    expect(second.status).toBe(409);
    expect(((await second.json()) as LakeStart).accepted).toBe(false);
  } finally {
    settled.resolve({ tables: [] });
    await lakeServer.stop(true);
  }
});

test("POST /lake rejects a body that is not a lake request", async () => {
  for (const body of [{}, { decode: "x" }, []]) {
    const response = await fetch(new URL("/lake", server.url), {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
});

async function post(body: unknown): Promise<Response> {
  return fetch(new URL("/decode", server.url), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function postLake(target: ReturnType<typeof Bun.serve>) {
  const request: LakeRequest = {
    decode: "s3://lake/decode/v1",
    registry: "s3://lake/registry.ndjson",
    stravaExport: null,
    output: "s3://lake/lake/v1",
  };
  return fetch(new URL("/lake", target.url), {
    method: "POST",
    body: JSON.stringify(request),
  });
}

function deps(runner?: LakeRunner): DecodeDeps & { runner: LakeRunner } {
  const raw: RawStore = {
    async get(key) {
      return new TextEncoder().encode(key);
    },
  };
  const lake: LakeStore = {
    async put() {},
    async putJson() {},
  };
  return {
    raw,
    lake,
    instance,
    decode: async () => activity(),
    runner:
      runner ??
      lakeRunner({
        build: async () => ({ tables: [] }),
        save: async () => {},
        exit: () => {},
      }),
  };
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
