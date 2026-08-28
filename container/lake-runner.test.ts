import { expect, test } from "bun:test";
import { lakeRunner } from "./lake-runner";
import type { LakeBuildSummary, LakeRequest, LakeTableResult } from "../src/transform/protocol";

const request: LakeRequest = {
  decode: "s3://lake/decode/v1",
  registry: "s3://lake/registry.ndjson",
  stravaExport: null,
  output: "s3://lake/lake/v1",
};

test("writes a summary carrying the tables when the build succeeds", async () => {
  const tables: LakeTableResult[] = [{ name: "activities", rows: 3 }];
  const saved = Promise.withResolvers<LakeBuildSummary>();
  const runner = lakeRunner({
    build: async () => ({ tables }),
    save: async (summary) => saved.resolve(summary),
    exit: () => {},
  });

  const start = runner.start(request);
  expect(start.accepted).toBe(true);

  const summary = await saved.promise;
  expect(summary.tables).toEqual(tables);
  expect(summary.error).toBeUndefined();
  if (start.accepted) {
    expect(summary.startedAt).toBe(start.startedAt);
  }
  expect(Date.parse(summary.finishedAt)).toBeGreaterThanOrEqual(Date.parse(summary.startedAt));
});

test("captures a failed build in the summary rather than throwing", async () => {
  const saved = Promise.withResolvers<LakeBuildSummary>();
  const runner = lakeRunner({
    build: async () => {
      throw new Error("catalog on fire");
    },
    save: async (summary) => saved.resolve(summary),
    exit: () => {},
  });

  runner.start(request);

  const summary = await saved.promise;
  expect(summary.error).toContain("catalog on fire");
  expect(summary.tables).toBeUndefined();
});

test("refuses a second build while one runs and accepts after it settles", async () => {
  const settled = Promise.withResolvers<{ tables: LakeTableResult[] }>();
  const saved = Promise.withResolvers<void>();
  const runner = lakeRunner({
    build: () => settled.promise,
    save: async () => saved.resolve(),
    exit: () => {},
  });

  expect(runner.start(request).accepted).toBe(true);
  expect(runner.start(request).accepted).toBe(false);

  settled.resolve({ tables: [] });
  await saved.promise;
  // The runner clears its in-flight flag in the microtasks after the save
  // resolves, and a macrotask is the cheap way to wait them all out.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runner.start(request).accepted).toBe(true);
});

test("drain defers exit until the running build settles", async () => {
  const settled = Promise.withResolvers<{ tables: LakeTableResult[] }>();
  const exited = Promise.withResolvers<void>();
  let exits = 0;
  const runner = lakeRunner({
    build: () => settled.promise,
    save: async () => {},
    exit: () => {
      exits += 1;
      exited.resolve();
    },
  });

  runner.start(request);
  expect(runner.drain()).toBe(true);
  // The library re-sends SIGTERM every couple of minutes while the container
  // runs, so a second drain has to change nothing.
  expect(runner.drain()).toBe(true);
  expect(exits).toBe(0);

  settled.resolve({ tables: [] });
  await exited.promise;
  expect(exits).toBe(1);
});

test("drain with no build running defers nothing", () => {
  const runner = lakeRunner({
    build: async () => ({ tables: [] }),
    save: async () => {},
    exit: () => {},
  });
  expect(runner.drain()).toBe(false);
});

test("a failed summary write still releases the drain", async () => {
  const exited = Promise.withResolvers<void>();
  const runner = lakeRunner({
    build: async () => ({ tables: [] }),
    save: async () => {
      throw new Error("AccessDenied");
    },
    exit: () => exited.resolve(),
  });

  runner.start(request);
  runner.drain();
  await exited.promise;
});
