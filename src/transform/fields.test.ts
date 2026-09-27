import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SECRETS } from "../../test/secrets";
import type { SubSportClient } from "./container";
import { backfillField } from "./fields";
import type { SubSportRequest } from "./protocol";
import { DELETED, type PatchableFields, type SitePatcher } from "./publish";

const testEnv: Env = { ...env, ...SECRETS };

const OLD = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM derived"),
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
});

interface Seed {
  activityId: string;
  sources?: (boolean | null)[];
  decoded?: boolean;
  publish?: "ok" | "failed" | "deleted" | null;
}

async function seed({
  activityId,
  sources = [null],
  decoded = true,
  publish = "ok",
}: Seed): Promise<void> {
  const statements = [
    env.REGISTRY.prepare(
      `INSERT INTO activities (activity_id, name, started_at, timezone, sport, duration_s, created_at, updated_at)
       VALUES (?1, NULL, '2026-01-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?2, ?2)`,
    ).bind(activityId, OLD),
    ...sources.map((indoor, index) =>
      env.REGISTRY.prepare(
        `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, indoor, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, '{}', ?4, ?5, ?5, NULL)`,
      ).bind(
        index === 0 ? "strava" : "wahoo",
        `${activityId}-${index}`,
        activityId,
        indoor === null ? null : Number(indoor),
        OLD,
      ),
    ),
  ];
  if (decoded) {
    statements.push(derived(activityId, "decode", "ok", "fingerprint", `decode/${activityId}`));
  }
  if (publish !== null) {
    statements.push(
      derived(
        activityId,
        "publish",
        publish === "deleted" ? "ok" : publish,
        publish === "deleted" ? DELETED : "fingerprint",
        null,
      ),
    );
  }
  await env.REGISTRY.batch(statements);
}

function derived(
  activityId: string,
  stage: string,
  status: string,
  fingerprint: string,
  outputKey: string | null,
): D1PreparedStatement {
  return env.REGISTRY.prepare(
    `INSERT INTO derived (activity_id, stage, input_fingerprint, output_key, status, attempts, error, updated_at, artifact_version)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, 0)`,
  ).bind(activityId, stage, fingerprint, outputKey, status, OLD);
}

// Answers from a table of sub_sports per activity. An activity named in
// `failing` comes back failed, the way a missing sessions file does.
function container(
  subSports: Record<string, string[]> = {},
  failing: string[] = [],
): SubSportClient & { requests: SubSportRequest[] } {
  const requests: SubSportRequest[] = [];
  return {
    requests,
    async subSports(request) {
      requests.push(request);
      return {
        outcomes: request.work.map(({ activityId }) =>
          failing.includes(activityId)
            ? { activityId, status: "failed", error: "sessions.parquet is missing" }
            : { activityId, status: "ok", subSports: subSports[activityId] ?? [] },
        ),
      };
    },
  };
}

function site(
  rejecting: string[] = [],
): SitePatcher & { patches: [string, Partial<PatchableFields>][] } {
  const patches: [string, Partial<PatchableFields>][] = [];
  return {
    patches,
    async patchActivity(activityId, fields) {
      if (rejecting.includes(activityId)) {
        throw new Error("ValidationError");
      }
      patches.push([activityId, fields]);
    },
  };
}

describe("indoor", () => {
  // A trainer ride the export typed as a plain Ride is known indoor only
  // through its file's session.
  it.each<{
    name: string;
    sources: (boolean | null)[];
    subSports: string[];
    expected: Record<string, number>;
  }>([
    {
      name: "any source says indoor",
      sources: [false, true],
      subSports: [],
      expected: { true: 1 },
    },
    {
      name: "only the FIT sub_sport says indoor",
      sources: [null],
      subSports: ["indoorCycling"],
      expected: { true: 1 },
    },
    { name: "a source says outdoor", sources: [false], subSports: [], expected: { false: 1 } },
    {
      name: "the file records an outdoor sub_sport",
      sources: [null],
      subSports: ["road"],
      expected: { false: 1 },
    },
  ])("counts $name", async ({ sources, subSports, expected }) => {
    await seed({ activityId: "a", sources });

    const page = await backfillField(testEnv, "indoor", {
      container: container({ a: subSports }),
    });

    expect(page.counts).toEqual(expected);
  });

  // Publish sends false here too, so the patch carries it, but the dry run
  // keeps it apart from a recorded false.
  it("reports unknown and patches false when nothing records it", async () => {
    await seed({ activityId: "a", sources: [null] });
    const patcher = site();

    const page = await backfillField(testEnv, "indoor", {
      container: container(),
      site: patcher,
      apply: true,
    });

    expect(page.counts).toEqual({ unknown: 1 });
    expect(patcher.patches).toEqual([["a", { indoor: false }]]);
  });

  it("reads sub_sports only for decoded activities", async () => {
    await seed({ activityId: "a", decoded: true });
    await seed({ activityId: "b", decoded: false, sources: [true] });
    const client = container();

    const page = await backfillField(testEnv, "indoor", { container: client });

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.work.map((work) => work.activityId)).toEqual(["a"]);
    expect(client.requests[0]?.work[0]?.decode).toContain("decode/a");
    expect(page.counts).toEqual({ true: 1, unknown: 1 });
  });

  it("skips the container when nothing on the page is decoded", async () => {
    await seed({ activityId: "a", decoded: false });
    const client = container();

    await backfillField(testEnv, "indoor", { container: client });

    expect(client.requests).toHaveLength(0);
  });

  it("fails an activity whose sub_sports could not be read, without patching it", async () => {
    await seed({ activityId: "a" });
    await seed({ activityId: "b" });
    const patcher = site();

    const page = await backfillField(testEnv, "indoor", {
      container: container({}, ["a"]),
      site: patcher,
      apply: true,
    });

    expect(page.failures).toEqual([{ activityId: "a", error: "sessions.parquet is missing" }]);
    expect(page.counts).toEqual({ unknown: 1 });
    expect(patcher.patches.map(([activityId]) => activityId)).toEqual(["b"]);
  });
});

describe("backfillField", () => {
  it("reports without patching unless applied", async () => {
    await seed({ activityId: "a", sources: [true] });
    const patcher = site();

    const page = await backfillField(testEnv, "indoor", { container: container(), site: patcher });

    expect(page).toMatchObject({ applied: false, activities: 1, patched: 0, counts: { true: 1 } });
    expect(patcher.patches).toEqual([]);
  });

  it("patches only the one field on each activity", async () => {
    await seed({ activityId: "a", sources: [true] });
    await seed({ activityId: "b", sources: [false] });
    const patcher = site();

    const page = await backfillField(testEnv, "indoor", {
      container: container(),
      site: patcher,
      apply: true,
    });

    expect(page.patched).toBe(2);
    expect(patcher.patches).toEqual([
      ["a", { indoor: true }],
      ["b", { indoor: false }],
    ]);
  });

  it("patches only activities the hub published", async () => {
    await seed({ activityId: "a", publish: "ok" });
    await seed({ activityId: "b", publish: "failed" });
    await seed({ activityId: "c", publish: "deleted" });
    await seed({ activityId: "d", publish: null });
    const patcher = site();

    const page = await backfillField(testEnv, "indoor", {
      container: container(),
      site: patcher,
      apply: true,
    });

    expect(page.activities).toBe(1);
    expect(patcher.patches.map(([activityId]) => activityId)).toEqual(["a"]);
  });

  it("records a rejected patch as that activity's failure", async () => {
    await seed({ activityId: "a" });
    await seed({ activityId: "b" });

    const page = await backfillField(testEnv, "indoor", {
      container: container(),
      site: site(["a"]),
      apply: true,
    });

    expect(page.patched).toBe(1);
    expect(page.failures).toEqual([{ activityId: "a", error: "Error: ValidationError" }]);
  });

  it("walks the published activities a page at a time", async () => {
    for (const activityId of ["a", "b", "c", "d", "e"]) {
      await seed({ activityId });
    }
    const client = container();

    const first = await backfillField(testEnv, "indoor", { container: client, limit: 2 });
    const second = await backfillField(testEnv, "indoor", {
      container: client,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const last = await backfillField(testEnv, "indoor", {
      container: client,
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });

    expect(first).toMatchObject({ activities: 2, nextCursor: "b" });
    expect(second).toMatchObject({ activities: 2, nextCursor: "d" });
    expect(last).toMatchObject({ activities: 1, nextCursor: null });
    expect(client.requests.map((request) => request.work.map((work) => work.activityId))).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
  });
});
