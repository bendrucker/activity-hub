import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DECODE_SCHEMA_VERSION } from "./transform/protocol";
import {
  activityRawKeys,
  ARTIFACT_VERSION,
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
  artifactVersion?: number;
}

async function seedDerived(seed: SeedDerived): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO derived (activity_id, stage, input_fingerprint, output_key, status, attempts, error, updated_at, artifact_version)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      seed.activityId,
      seed.stage,
      seed.fingerprint ?? "fingerprint",
      seed.status,
      seed.attempts ?? 0,
      seed.error ?? null,
      seed.updatedAt ?? NEWER,
      seed.artifactVersion ?? ARTIFACT_VERSION[seed.stage],
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

    expect(await inputFingerprint(env.RAW, ["raw/test/one.fit", "raw/test/two.fit"])).toBe(
      await inputFingerprint(env.RAW, ["raw/test/two.fit", "raw/test/one.fit"]),
    );
  });

  it("returns the sentinel for an activity with no raw keys", async () => {
    expect(await inputFingerprint(env.RAW, [])).toBe(EMPTY_FINGERPRINT);
  });

  // Pinned so a change to what the digest covers has to come here and say so.
  // Every fingerprint moving re-runs every stage over the whole archive.
  it("digests the keys and etags and nothing else", async () => {
    await env.RAW.put("raw/test/pinned.fit", "bytes");

    expect(await inputFingerprint(env.RAW, ["raw/test/pinned.fit"])).toBe(
      await sha256(`raw/test/pinned.fit:${(await env.RAW.head("raw/test/pinned.fit"))?.etag}`),
    );
  });
});

// The decoder's own shape is invisible to the raw bytes, so a bump has to
// reach the sweep on its own. This is the whole mechanism that re-decodes an
// archive after a decoder gains a column.
describe("artifact version", () => {
  beforeEach(async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
  });

  it("selects a row written by an older decoder", async () => {
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      artifactVersion: DECODE_SCHEMA_VERSION - 1,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("leaves a row written by the current decoder alone", async () => {
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual([]);
  });

  // Without this the sweep would enqueue the activity and the consumer would
  // ack it as current on a fingerprint that never moved, so the bump would
  // spend a queue delivery per activity and decode none of them.
  it("is not current on a matching fingerprint under an older decoder", async () => {
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      artifactVersion: DECODE_SCHEMA_VERSION - 1,
    });

    expect(await isCurrent(env.REGISTRY, "a1", "decode", "fingerprint")).toBe(false);
  });

  // A parked row gets its budget back, because the ceiling counts attempts
  // against one decoder and this is a different one.
  it("starts a parked row's attempts over", async () => {
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS,
      artifactVersion: DECODE_SCHEMA_VERSION - 1,
    });

    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "fingerprint",
      status: "failed",
      error: "still broken",
    });

    expect(await attemptsFor("a1", "decode")).toBe(1);
  });
});

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

  // The whole trap: an edit makes the parked row stale again, that run fails
  // on the new bytes for any reason, and its own failure stamps the newest
  // updated_at. Every disjunct is then false forever unless the budget
  // restarts with the input.
  it("keeps retrying an activity that parked before its input changed", async () => {
    await seedActivity("a1");
    // A real edit timestamp, not the NEWER sentinel: the trap only springs
    // once the failure's own updated_at overtakes the source's, which a date
    // in 2099 never allows.
    await seedSource({
      source: "wahoo",
      sourceId: "1",
      activityId: "a1",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS,
      fingerprint: "fp-1",
      updatedAt: OLD,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);

    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "fp-2",
      status: "failed",
      error: "container unreachable",
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual(["a1"]);
  });

  it("ignores another stage's derived row", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({ activityId: "a1", stage: "decode", status: "ok" });

    expect(await staleActivities(env.REGISTRY, "lake", 10)).toEqual(["a1"]);
  });

  // Nothing about the source changed, so every other disjunct is false. The
  // upstream join is the only thing that can see a decode that ran again, and
  // without it a decoder bump would re-decode the corpus and republish none of
  // it.
  it("selects a stage whose upstream ran after it did", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({
      activityId: "a1",
      stage: "publish",
      status: "ok",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(await staleActivities(env.REGISTRY, "publish", 10)).toEqual([]);

    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      updatedAt: NEWER,
    });

    expect(await staleActivities(env.REGISTRY, "publish", 10)).toEqual(["a1"]);
  });

  // decode joins to itself, where the comparison is a row against its own
  // timestamp. A stage with no upstream has to come out exactly as it did
  // before the join existed.
  it("leaves a stage with no upstream unaffected", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      updatedAt: NEWER,
    });

    expect(await staleActivities(env.REGISTRY, "decode", 10)).toEqual([]);
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

    expect(await staleActivities(env.REGISTRY, "decode", 2)).toEqual(["a2", "a3"]);
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

  // The ceiling is meant to stop retrying bytes that cannot be decoded. New
  // bytes are a different claim, and an activity that parked under the old
  // input would otherwise get a single try at the new one: the failure stamps
  // the newest updated_at, which is the only reason STALE re-selected it.
  it("restarts the budget when the input changes", async () => {
    for (const _ of [1, 2, 3]) {
      await recordOutcome(env.REGISTRY, {
        activityId: "a1",
        stage: "decode",
        inputFingerprint: "fp-1",
        status: "failed",
        error: "boom",
      });
    }
    await recordOutcome(env.REGISTRY, {
      activityId: "a1",
      stage: "decode",
      inputFingerprint: "fp-2",
      status: "failed",
      error: "container unreachable",
    });

    expect(await attemptsFor("a1", "decode")).toBe(1);
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
    await seedActivity("a3");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedSource({
      source: "wahoo",
      sourceId: "2",
      activityId: "a2",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await seedSource({ source: "wahoo", sourceId: "3", activityId: "a3" });
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
    // `lake` is absent because it writes no per-activity row, so asking it for
    // its oldest stale activity would answer with the whole registry. Publish
    // has written none of these yet, so its oldest is simply the oldest source.
    expect(report.oldestStale).toEqual([
      { stage: "decode", activityId: "a3", sourceUpdatedAt: OLD },
      { stage: "publish", activityId: "a1", sourceUpdatedAt: OLD },
    ]);
    expect(report.failures).toEqual([
      {
        activityId: "a2",
        stage: "decode",
        error: "boom",
        attempts: MAX_ATTEMPTS,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
  });

  // A row out of attempts is absent from oldestStale for the same reason it
  // will never retry, so a stage holding one and nothing else looks caught up.
  // The parked count is the only thing separating the two.
  it("counts a failure at the attempt ceiling apart from one that still retries", async () => {
    await seedActivity("a1");
    await seedActivity("a2");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    await seedSource({ source: "wahoo", sourceId: "2", activityId: "a2" });
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      attempts: 1,
      error: "transient",
    });
    await seedDerived({
      activityId: "a2",
      stage: "decode",
      status: "failed",
      attempts: MAX_ATTEMPTS,
      error: "no decodable raw key",
    });

    const report = await pipelineReport(env.REGISTRY);

    expect(report.parked).toEqual([{ stage: "decode", count: 1 }]);
    expect(report.failures.map((failure) => [failure.activityId, failure.attempts])).toEqual(
      expect.arrayContaining([
        ["a1", 1],
        ["a2", MAX_ATTEMPTS],
      ]),
    );
    // The one still under the ceiling is what the next sweep picks up.
    expect(report.oldestStale.find((entry) => entry.stage === "decode")?.activityId).toBe("a1");
  });

  it("reports empty over an empty pipeline", async () => {
    const report = await pipelineReport(env.REGISTRY);

    expect(report).toEqual({
      counts: [],
      oldestStale: [],
      parked: [],
      failures: [],
    });
  });
});
