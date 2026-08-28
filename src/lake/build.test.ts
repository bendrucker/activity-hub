import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { SECRETS } from "../../test/secrets";
import { buildLake, latestExportCsv } from "./build";
import type { LakeClient } from "../transform/container";

const testEnv: Env = { ...env, ...SECRETS };

async function seedExport(date: string, csv = true): Promise<void> {
  const prefix = `raw/strava/export/${date}/`;
  await env.RAW.put(`${prefix}activities/1.fit.gz`, "bytes");
  if (csv) {
    await env.RAW.put(`${prefix}activities.csv`, "Activity ID\n1\n");
  }
}

async function clearRaw(): Promise<void> {
  const listed = await env.RAW.list({ prefix: "raw/strava/export/" });
  await Promise.all(listed.objects.map((object) => env.RAW.delete(object.key)));
}

function client(): LakeClient & { build: ReturnType<typeof vi.fn> } {
  const build = vi.fn(() =>
    Promise.resolve({
      accepted: true as const,
      startedAt: "2026-08-27T08:00:00.000Z",
    }),
  );
  return { build };
}

beforeEach(async () => {
  await clearRaw();
  await env.REGISTRY.prepare("DELETE FROM activity_sources").run();
  await env.REGISTRY.prepare("DELETE FROM activities").run();
});

it("picks the newest archived export", async () => {
  await seedExport("2025-01-01");
  await seedExport("2026-07-16");

  expect(await latestExportCsv(env.RAW)).toBe(
    "raw/strava/export/2026-07-16/activities.csv",
  );
});

// A partial upload leaves the activity files under a dated prefix with no CSV.
// Naming it anyway would fail the build inside DuckDB, where the error points
// at a URI rather than at the archive that never finished.
it("reports no export when the newest prefix has no csv", async () => {
  await seedExport("2026-07-16", false);

  expect(await latestExportCsv(env.RAW)).toBeNull();
});

it("reports no export when nothing is archived", async () => {
  expect(await latestExportCsv(env.RAW)).toBeNull();
});

it("hands the container S3 URIs for every source", async () => {
  await seedExport("2026-07-16");
  const lake = client();

  const result = await buildLake(testEnv, { client: lake });

  expect(lake.build).toHaveBeenCalledWith({
    decode: "s3://activity-hub-lake/decode/v1",
    registry: `s3://activity-hub-lake/${result.registry.key}`,
    stravaExport:
      "s3://activity-hub-raw/raw/strava/export/2026-07-16/activities.csv",
    output: "s3://activity-hub-lake/lake/v1",
  });
  // The snapshot key is unique per run so a trigger that arrives while a
  // build is running cannot overwrite the object that build is reading.
  expect(result.registry.key).toMatch(/^lake\/registry\/v1\/.+\.ndjson$/);
  expect(result.registry.activities).toBe(0);
  expect(result.start).toEqual({
    accepted: true,
    startedAt: "2026-08-27T08:00:00.000Z",
  });
});

it("builds with a null export rather than refusing to run", async () => {
  const lake = client();

  await buildLake(testEnv, { client: lake });

  expect(lake.build).toHaveBeenCalledWith(
    expect.objectContaining({ stravaExport: null }),
  );
});
