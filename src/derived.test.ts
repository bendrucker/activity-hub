import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activityRawKeys,
  clearDerived,
  EMPTY_FINGERPRINT,
  inputFingerprint,
  isCurrent,
  MAX_ATTEMPTS,
  pipelineReport,
  recordOutcome,
  staleActivities,
  type DerivedStatus,
  type Stage,
} from "./derived";

const OLD = "2026-01-01T00:00:00.000Z";
const NEWER = "2099-01-01T00:00:00.000Z";

async function seedActivity(activityId: string): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at)
     VALUES (?1, '2026-01-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?2, ?2)`,
  )
    .bind(activityId, OLD)
    .run();
}

interface SeedSource {
  source: string;
  sourceId: string;
  activityId: string;
  rawKeys?: Record<string, string>;
  updatedAt?: string;
  deletedAt?: string;
}

async function seedSource(seed: SeedSource): Promise<void> {
  const updatedAt = seed.updatedAt ?? OLD;
  await env.REGISTRY.prepare(
    `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
  )
    .bind(
      seed.source,
      seed.sourceId,
      seed.activityId,
      JSON.stringify(seed.rawKeys ?? {}),
      updatedAt,
      seed.deletedAt ?? null,
    )
    .run();
}

interface SeedDerived {
  activityId: string;
  stage: Stage;
  status: DerivedStatus;
  fingerprint?: string;
  attempts?: number;
  error?: string;
  updatedAt?: string;
}

async function seedDerived(seed: SeedDerived): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO derived (activity_id, stage, input_fingerprint, output_key, status, attempts, error, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      seed.activityId,
      seed.stage,
      seed.fingerprint ?? "fingerprint",
      seed.status,
      seed.attempts ?? 0,
      seed.error ?? null,
      seed.updatedAt ?? NEWER,
    )
    .run();
}

async function attemptsFor(activityId: string, stage: Stage): Promise<number> {
  const row = await env.REGISTRY.prepare(
    "SELECT attempts FROM derived WHERE activity_id = ?1 AND stage = ?2",
  )
    .bind(activityId, stage)
    .first<{ attempts: number }>();
  return row?.attempts ?? -1;
}

beforeEach(async () => {
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM derived"),
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
  const listed = await env.RAW.list({ prefix: "raw/test/" });
  await Promise.all(listed.objects.map((object) => env.RAW.delete(object.key)));
});

describe("activityRawKeys", () => {
  it("merges original keys across an activity's sources", async () => {
    await seedActivity("a1");
    await seedSource({
      source: "wahoo",
      sourceId: "1",
      activityId: "a1",
      rawKeys: { original: "raw/test/wahoo.fit", summary: "raw/test/s.json" },
    });
    await seedSource({
      source: "strava",
      sourceId: "2",
      activityId: "a1",
      rawKeys: { original: "raw/test/strava.fit", streams: "raw/test/x.json" },
    });

    expect(await activityRawKeys(env.REGISTRY, "a1")).toEqual([
      "raw/test/strava.fit",
      "raw/test/wahoo.fit",
    ]);
  });

  it("ignores soft-deleted sources and sources with no original", async () => {
    await seedActivity("a1");
    await seedSource({
      source: "wahoo",
      sourceId: "1",
      activityId: "a1",
      rawKeys: { original: "raw/test/gone.fit" },
      deletedAt: OLD,
    });
    await seedSource({
      source: "strava",
      sourceId: "2",
      activityId: "a1",
      rawKeys: { streams: "raw/test/x.json" },
    });

    expect(await activityRawKeys(env.REGISTRY, "a1")).toEqual([]);
  });
});

describe("inputFingerprint", () => {
  it("is stable while the object is unchanged", async () => {
    await env.RAW.put("raw/test/one.fit", "bytes");

    const first = await inputFingerprint(env.RAW, ["raw/test/one.fit"]);
    const second = await inputFingerprint(env.RAW, ["raw/test/one.fit"]);

    expect(first).toBe(second);
    expect(first).not.toBe(EMPTY_FINGERPRINT);
  });

  it("changes when the object's etag changes", async () => {
    await env.RAW.put("raw/test/one.fit", "bytes");
    const before = await inputFingerprint(env.RAW, ["raw/test/one.fit"]);

    await env.RAW.put("raw/test/one.fit", "different bytes");
    const after = await inputFingerprint(env.RAW, ["raw/test/one.fit"]);

    expect(after).not.toBe(before);
  });

  it("fingerprints a missing object, distinctly from a present one", async () => {
    await env.RAW.put("raw/test/one.fit", "bytes");
    const present = await inputFingerprint(env.RAW, ["raw/test/one.fit"]);

    await env.RAW.delete("raw/test/one.fit");
    const missing = await inputFingerprint(env.RAW, ["raw/test/one.fit"]);

    expect(missing).not.toBe(present);
    expect(missing).not.toBe(EMPTY_FINGERPRINT);
    expect(missing).toBe(await inputFingerprint(env.RAW, ["raw/test/one.fit"]));
  });

  it("does not depend on the order the keys arrive in", async () => {
    await env.RAW.put("raw/test/one.fit", "one");
    await env.RAW.put("raw/test/two.fit", "two");

    expect(
      await inputFingerprint(env.RAW, ["raw/test/one.fit", "raw/test/two.fit"]),
    ).toBe(
      await inputFingerprint(env.RAW, ["raw/test/two.fit", "raw/test/one.fit"]),
    );
  });

  it("returns the sentinel for an activity with no raw keys", async () => {
    expect(await inputFingerprint(env.RAW, [])).toBe(EMPTY_FINGERPRINT);
  });
});

describe("isCurrent", () => {
  beforeEach(async () => {
    await seedActivity("a1");
  });

  it("is true for an ok row with the same fingerprint", async () => {
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "ok",
      outputKey: "decode/v1/a1/",
    });

    expect(await isCurrent(env.REGISTRY, "a1", "decode", "abc")).toBe(true);
  });

  it("is false once the fingerprint changes", async () => {
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "ok",
    });

    expect(await isCurrent(env.REGISTRY, "a1", "decode", "def")).toBe(false);
  });

  it("is false for a failed row, matching fingerprint or not", async () => {
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "failed",
      error: "boom",
    });

    expect(await isCurrent(env.REGISTRY, "a1", "decode", "abc")).toBe(false);
  });

  it("is false for another stage's ok row", async () => {
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "ok",
    });

    expect(await isCurrent(env.REGISTRY, "a1", "lake", "abc")).toBe(false);
  });
});

describe("staleActivities", () => {
  it("selects an activity with no derived row", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("skips an activity whose derived row is newer than its sources", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual([]);
  });

  it("selects an activity whose source was updated after the derived row", async () => {
    await seedActivity("a1");
    await seedSource({
      source: "wahoo",
      sourceId: "1",
      activityId: "a1",
      updatedAt: NEWER,
    });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      updatedAt: OLD,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("uses the newest source row, not an arbitrary one", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedSource({
      source: "strava",
      sourceId: "2",
      activityId: "a1",
      updatedAt: NEWER,
    });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("skips an activity whose every source is soft-deleted", async () => {
    await seedActivity("a1");
    await seedSource({
      source: "wahoo",
      sourceId: "1",
      activityId: "a1",
      deletedAt: OLD,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual([]);
  });

  it("keeps an activity that still has one live source", async () => {
    await seedActivity("a1");
    await seedSource({
      source: "wahoo",
      sourceId: "1",
      activityId: "a1",
      deletedAt: OLD,
    });
    await seedSource({ source: "strava", sourceId: "2", activityId: "a1" });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("retries a failed row below the attempt ceiling", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS - 1,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("parks a failed row at the attempt ceiling", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual([]);
  });

  it("ignores another stage's derived row", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });

    expect(await staleActivities(env.REGISTRY, "lake", 10)).toEqual(["a1"]);
  });

  it("drains oldest first and honors the limit", async () => {
    for (const { activityId, updatedAt } of [
      { activityId: "a1", updatedAt: "2026-03-01T00:00:00.000Z" },
      { activityId: "a2", updatedAt: "2026-01-01T00:00:00.000Z" },
      { activityId: "a3", updatedAt: "2026-02-01T00:00:00.000Z" },
    ]) {
      await seedActivity(activityId);
      await seedSource({
        source: "wahoo",
        sourceId: activityId,
        activityId,
        updatedAt,
      });
    }

    expect(await staleActivities(env.REGISTRY, "decode", 2)).toEqual([
      "a2",
      "a3",
    ]);
  });
});

describe("recordOutcome", () => {
  beforeEach(async () => {
    await seedActivity("a1");
  });

  it("counts attempts across repeated failures", async () => {
    for (const _ of [1, 2, 3]) {
      await recordOutcome(env.REGISTRY, {
        activityId: "a1",
        stage: "decode",
        inputFingerprint: "abc",
        status: "failed",
        error: "boom",
      });
    }

    expect(await attemptsFor("a1", "decode")).toBe(3);
  });

  it("resets attempts once the stage succeeds", async () => {
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "failed",
      error: "boom",
    });
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "ok",
      outputKey: "decode/v1/a1/",
    });

    expect(await attemptsFor("a1", "decode")).toBe(0);
  });

  it("replaces the previous outcome's output key and error", async () => {
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "abc",
      status: "failed",
      error: "boom",
    });
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "def",
      status: "ok",
      outputKey: "decode/v1/a1/",
    });

    const row = await env.REGISTRY.prepare(
      "SELECT input_fingerprint, output_key, status, error FROM derived WHERE activity_id = 'a1'",
    ).first<{
      input_fingerprint: string;
      output_key: string | null;
      status: string;
      error: string | null;
    }>();

    expect(row).toEqual({
      input_fingerprint: "def",
      output_key: "decode/v1/a1/",
      status: "ok",
      error: null,
    });
  });
});

describe("clearDerived", () => {
  beforeEach(async () => {
    await seedActivity("a1");
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });
    await seedDerived({ activityId: "a1", stage: "lake", status: "ok" });
  });

  it("clears one stage when given one", async () => {
    await clearDerived(env.REGISTRY, "a1", "decode");

    const { results } = await env.REGISTRY.prepare(
      "SELECT stage FROM derived WHERE activity_id = 'a1'",
    ).all<{ stage: string }>();
    expect(results).toEqual([{ stage: "lake" }]);
  });

  it("clears every stage when given none", async () => {
    await clearDerived(env.REGISTRY, "a1");

    const { results } = await env.REGISTRY.prepare(
      "SELECT stage FROM derived WHERE activity_id = 'a1'",
    ).all<{ stage: string }>();
    expect(results).toEqual([]);
  });
});

describe("pipelineReport", () => {
  it("counts by stage and status, and names the oldest stale activity", async () => {
    await seedActivity("a1");
    await seedActivity("a2");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedSource({
      source: "wahoo",
      sourceId: "2",
      activityId: "a2",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });
    await seedDerived({
      activityId: "a2",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS,
      error: "boom",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    const report = await pipelineReport(env.REGISTRY);

    expect(report.counts).toEqual([
      { stage: "decode", status: "failed", count: 1 },
      { stage: "decode", status: "ok", count: 1 },
    ]);
    expect(report.oldestStale).toEqual([
      { stage: "lake", activityId: "a1", sourceUpdatedAt: OLD },
      { stage: "publish", activityId: "a1", sourceUpdatedAt: OLD },
    ]);
    expect(report.failures).toEqual([
      {
        activityId: "a2",
        stage: "decode",
        error: "boom",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
  });

  it("reports empty over an empty pipeline", async () => {
    const report = await pipelineReport(env.REGISTRY);

    expect(report).toEqual({ counts: [], oldestStale: [], failures: [] });
  });
});
