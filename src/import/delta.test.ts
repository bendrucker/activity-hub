import { env } from "cloudflare:test";
import { decodeTime } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import type { SourceRecord } from "../record";
import {
  buildDelta,
  type RegistryState,
  type RegistrySourceRow,
} from "./delta";

const START = "2026-07-01T14:00:00.000Z";
const NOW = "2026-07-16T00:00:00.000Z";

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    source: "strava",
    sourceId: "12345",
    startedAt: START,
    timezone: "America/Los_Angeles",
    sport: "ride",
    durationS: 3600,
    rawKeys: { original: "raw/strava/activities/12345/original.fit.gz" },
    ...overrides,
  };
}

function empty(): RegistryState {
  return { activities: [], sources: [] };
}

async function loadState(): Promise<RegistryState> {
  const activities = await env.REGISTRY.prepare(
    "SELECT activity_id, started_at, sport, duration_s FROM activities",
  ).all<{
    activity_id: string;
    started_at: string;
    sport: SourceRecord["sport"];
    duration_s: number;
  }>();
  const sources = await env.REGISTRY.prepare(
    "SELECT source, source_id, activity_id, raw_keys FROM activity_sources",
  ).all<{
    source: RegistrySourceRow["source"];
    source_id: string;
    activity_id: string;
    raw_keys: string;
  }>();
  return {
    activities: activities.results.map((row) => ({
      activityId: row.activity_id,
      startedAt: row.started_at,
      sport: row.sport,
      durationS: row.duration_s,
    })),
    sources: sources.results.map((row) => ({
      source: row.source,
      sourceId: row.source_id,
      activityId: row.activity_id,
      rawKeys: JSON.parse(row.raw_keys) as Record<string, string>,
    })),
  };
}

async function apply(statements: string[]): Promise<void> {
  for (const statement of statements) {
    await env.REGISTRY.prepare(statement).run();
  }
}

describe("buildDelta", () => {
  beforeEach(async () => {
    await env.REGISTRY.batch([
      env.REGISTRY.prepare("DELETE FROM activity_sources"),
      env.REGISTRY.prepare("DELETE FROM activities"),
    ]);
  });

  it("mints activities against an empty registry", () => {
    const delta = buildDelta(empty(), [record()], NOW);
    expect(delta.results).toHaveLength(1);
    expect(delta.results[0]?.outcome).toBe("minted");
    expect(decodeTime(delta.results[0]?.activityId ?? "")).toBe(
      Date.parse(START),
    );
    expect(delta.statements).toHaveLength(2);
  });

  it("emits valid SQL that upserts into D1", async () => {
    const delta = buildDelta(empty(), [record()], NOW);
    await apply(delta.statements);

    const state = await loadState();
    expect(state.activities).toHaveLength(1);
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0]).toMatchObject({
      source: "strava",
      sourceId: "12345",
      rawKeys: { original: "raw/strava/activities/12345/original.fit.gz" },
    });
  });

  it("emits an empty delta when re-run over its own output", async () => {
    const first = buildDelta(
      empty(),
      [
        record(),
        record({ sourceId: "12346", startedAt: "2026-07-02T09:00:00.000Z" }),
      ],
      NOW,
    );
    await apply(first.statements);

    const second = buildDelta(
      await loadState(),
      [
        record(),
        record({ sourceId: "12346", startedAt: "2026-07-02T09:00:00.000Z" }),
      ],
      NOW,
    );
    expect(second.statements).toEqual([]);
    expect(second.results.map((result) => result.outcome)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("updates raw_keys when new keys appear for an existing source", async () => {
    const first = buildDelta(empty(), [record()], NOW);
    await apply(first.statements);

    const second = buildDelta(
      await loadState(),
      [
        record({
          rawKeys: {
            "photos/a.jpg": "raw/strava/activities/12345/photos/a.jpg",
          },
        }),
      ],
      NOW,
    );
    expect(second.results[0]?.outcome).toBe("updated");
    await apply(second.statements);

    const state = await loadState();
    expect(state.sources[0]?.rawKeys).toEqual({
      original: "raw/strava/activities/12345/original.fit.gz",
      "photos/a.jpg": "raw/strava/activities/12345/photos/a.jpg",
    });
  });

  it("attaches to a matching activity from another source", () => {
    const state: RegistryState = {
      activities: [
        {
          activityId: "01JZWAHOO0000000000000000",
          startedAt: "2026-07-01T14:00:30.000Z",
          sport: "ride",
          durationS: 3650,
        },
      ],
      sources: [
        {
          source: "wahoo",
          sourceId: "67890",
          activityId: "01JZWAHOO0000000000000000",
          rawKeys: {},
        },
      ],
    };
    const delta = buildDelta(state, [record()], NOW);
    expect(delta.results[0]).toMatchObject({
      outcome: "attached",
      activityId: "01JZWAHOO0000000000000000",
    });
  });

  it("never attaches two records from the same source to one activity", () => {
    const delta = buildDelta(
      empty(),
      [
        record(),
        record({ sourceId: "12346", startedAt: "2026-07-01T14:00:10.000Z" }),
      ],
      NOW,
    );
    expect(delta.results.map((result) => result.outcome)).toEqual([
      "minted",
      "minted",
    ]);
  });

  it("escapes quotes in SQL text values", async () => {
    const delta = buildDelta(
      empty(),
      [record({ rawKeys: { original: "raw/strava/o'brien.fit" } })],
      NOW,
    );
    await apply(delta.statements);
    const state = await loadState();
    expect(state.sources[0]?.rawKeys).toEqual({
      original: "raw/strava/o'brien.fit",
    });
  });

  it("rejects non-Strava records", () => {
    expect(() =>
      buildDelta(empty(), [record({ source: "wahoo" })], NOW),
    ).toThrow("unsupported import source");
  });
});
