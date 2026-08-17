import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { exportRegistry, REGISTRY_KEY } from "./registry";

const AT = "2026-01-01T00:00:00.000Z";

async function seedActivity(activityId: string, startedAt = AT): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at)
     VALUES (?1, ?2, 'America/Los_Angeles', 'ride', 3600, ?3, ?3)`,
  )
    .bind(activityId, startedAt, AT)
    .run();
}

async function seedSource(
  source: string,
  sourceId: string,
  activityId: string,
  deletedAt: string | null = null,
): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, '{}', ?4, ?4, ?5)`,
  )
    .bind(source, sourceId, activityId, AT, deletedAt)
    .run();
}

async function snapshot(): Promise<Record<string, unknown>[]> {
  const object = await env.LAKE.get(REGISTRY_KEY);
  const text = (await object?.text()) ?? "";
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  await env.REGISTRY.prepare("DELETE FROM activity_sources").run();
  await env.REGISTRY.prepare("DELETE FROM activities").run();
});

it("writes one line per activity with each provider id in its own column", async () => {
  await seedActivity("a");
  await seedSource("strava", "111", "a");
  await seedSource("wahoo", "222", "a");

  const result = await exportRegistry(env.REGISTRY, env.LAKE);

  expect(result).toEqual({ key: REGISTRY_KEY, activities: 1 });
  expect(await snapshot()).toEqual([
    expect.objectContaining({
      activity_id: "a",
      strava_id: "111",
      wahoo_id: "222",
      deleted_at: null,
    }),
  ]);
});

it("keeps an activity live while any source survives", async () => {
  await seedActivity("a");
  await seedSource("strava", "111", "a", AT);
  await seedSource("wahoo", "222", "a");

  await exportRegistry(env.REGISTRY, env.LAKE);

  expect((await snapshot())[0]?.deleted_at).toBeNull();
});

it("marks an activity deleted once every source is", async () => {
  await seedActivity("a");
  await seedSource("strava", "111", "a", AT);
  await seedSource("wahoo", "222", "a", AT);

  await exportRegistry(env.REGISTRY, env.LAKE);

  expect((await snapshot())[0]?.deleted_at).toBe(AT);
});

it("includes an activity that has no sources at all", async () => {
  await seedActivity("orphan");

  await exportRegistry(env.REGISTRY, env.LAKE);

  expect(await snapshot()).toEqual([
    expect.objectContaining({
      activity_id: "orphan",
      strava_id: null,
      wahoo_id: null,
      deleted_at: null,
    }),
  ]);
});

// The export pages at 1,000 rows, so a corpus larger than one page is the only
// case that proves the loop advances rather than rewriting the first page.
it("pages past the D1 row limit", async () => {
  const total = 1001;
  const statements = Array.from({ length: total }, (_, index) =>
    env.REGISTRY.prepare(
      `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at)
       VALUES (?1, ?2, 'America/Los_Angeles', 'ride', 3600, ?2, ?2)`,
    ).bind(String(index).padStart(5, "0"), AT),
  );
  await env.REGISTRY.batch(statements);

  const result = await exportRegistry(env.REGISTRY, env.LAKE);

  expect(result.activities).toBe(total);
  const lines = await snapshot();
  expect(lines).toHaveLength(total);
  expect(new Set(lines.map((line) => line.activity_id)).size).toBe(total);
});
