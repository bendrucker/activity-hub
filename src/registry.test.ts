import { env } from "cloudflare:test";
import { decodeTime } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertSourceRecord, type SourceRecord } from "./registry";

const START = "2026-07-01T14:00:00.000Z";

function strava(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    source: "strava",
    sourceId: "12345",
    startedAt: START,
    timezone: "America/Los_Angeles",
    sport: "ride",
    durationS: 3600,
    rawKeys: { detail: "raw/strava/12345/detail.json" },
    ...overrides,
  };
}

function wahoo(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    source: "wahoo",
    sourceId: "67890",
    startedAt: "2026-07-01T14:00:30.000Z",
    timezone: "America/Los_Angeles",
    sport: "ride",
    durationS: 3650,
    rawKeys: { fit: "raw/wahoo/67890/workout.fit" },
    ...overrides,
  };
}

async function countActivities(): Promise<number> {
  const row = await env.REGISTRY.prepare(
    "SELECT COUNT(*) AS n FROM activities",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("upsertSourceRecord", () => {
  beforeEach(async () => {
    await env.REGISTRY.batch([
      env.REGISTRY.prepare("DELETE FROM activity_sources"),
      env.REGISTRY.prepare("DELETE FROM activities"),
    ]);
  });

  it("mints a new activity for a single source", async () => {
    const result = await upsertSourceRecord(env.REGISTRY, strava());

    expect(result.outcome).toBe("minted");
    expect(decodeTime(result.activityId)).toBe(Date.parse(START));

    const activity = await env.REGISTRY.prepare(
      "SELECT * FROM activities WHERE activity_id = ?1",
    )
      .bind(result.activityId)
      .first();
    expect(activity).toMatchObject({
      started_at: START,
      timezone: "America/Los_Angeles",
      sport: "ride",
      duration_s: 3600,
    });
  });

  it("is idempotent for the same (source, source_id)", async () => {
    const first = await upsertSourceRecord(env.REGISTRY, strava());
    const second = await upsertSourceRecord(
      env.REGISTRY,
      strava({ rawKeys: { streams: "raw/strava/12345/streams.json" } }),
    );

    expect(second.outcome).toBe("existing");
    expect(second.activityId).toBe(first.activityId);
    expect(await countActivities()).toBe(1);

    const source = await env.REGISTRY.prepare(
      "SELECT raw_keys FROM activity_sources WHERE source = 'strava' AND source_id = '12345'",
    ).first<{ raw_keys: string }>();
    expect(JSON.parse(source?.raw_keys ?? "{}")).toEqual({
      detail: "raw/strava/12345/detail.json",
      streams: "raw/strava/12345/streams.json",
    });
  });

  it("attaches a Wahoo record to a matching Strava activity", async () => {
    const first = await upsertSourceRecord(env.REGISTRY, strava());
    const second = await upsertSourceRecord(env.REGISTRY, wahoo());

    expect(second.outcome).toBe("attached");
    expect(second.activityId).toBe(first.activityId);
    expect(await countActivities()).toBe(1);

    const activity = await env.REGISTRY.prepare(
      "SELECT started_at, duration_s, timezone FROM activities WHERE activity_id = ?1",
    )
      .bind(first.activityId)
      .first();
    expect(activity).toMatchObject({
      started_at: "2026-07-01T14:00:30.000Z",
      duration_s: 3650,
    });
  });

  it("mints when the start delta exceeds the window", async () => {
    await upsertSourceRecord(env.REGISTRY, strava());
    const result = await upsertSourceRecord(
      env.REGISTRY,
      wahoo({ startedAt: "2026-07-01T14:02:01.000Z" }),
    );

    expect(result.outcome).toBe("minted");
    expect(await countActivities()).toBe(2);
  });

  it("mints on sport mismatch even within the window", async () => {
    await upsertSourceRecord(env.REGISTRY, strava());
    const result = await upsertSourceRecord(
      env.REGISTRY,
      wahoo({ sport: "run" }),
    );

    expect(result.outcome).toBe("minted");
    expect(await countActivities()).toBe(2);
  });

  it("never attaches two records from the same source", async () => {
    await upsertSourceRecord(env.REGISTRY, strava());
    const result = await upsertSourceRecord(
      env.REGISTRY,
      strava({ sourceId: "12346", startedAt: "2026-07-01T14:00:10.000Z" }),
    );

    expect(result.outcome).toBe("minted");
    expect(await countActivities()).toBe(2);
  });

  it("attaches to the candidate with the smallest start delta", async () => {
    const far = await upsertSourceRecord(
      env.REGISTRY,
      strava({ sourceId: "far", startedAt: "2026-07-01T13:59:00.000Z" }),
    );
    const near = await upsertSourceRecord(
      env.REGISTRY,
      strava({ sourceId: "near", startedAt: "2026-07-01T14:00:40.000Z" }),
    );
    expect(far.outcome).toBe("minted");
    expect(near.outcome).toBe("minted");

    const result = await upsertSourceRecord(env.REGISTRY, wahoo());
    expect(result.outcome).toBe("attached");
    expect(result.activityId).toBe(near.activityId);
  });
});
