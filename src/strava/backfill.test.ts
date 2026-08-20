import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubQueue, type QueueStub } from "../../test/queue-stub";
import { SECRETS } from "../../test/secrets";
import type { StravaIngestMessage } from "../ingest";
import {
  backfillStravaPhotos,
  backfillStravaStreams,
  drainPhotoBackfillTargets,
  PHOTO_DRAIN,
  seedPhotoBackfillTargets,
} from "./backfill";

function testEnv(queue: QueueStub<StravaIngestMessage>): Env {
  return { ...env, ...SECRETS, INGEST_QUEUE: queue };
}

async function seed(sourceId: string, rawKeys: string): Promise<void> {
  const now = new Date().toISOString();
  const activityId = `activity-${sourceId}`;
  await env.REGISTRY.batch([
    env.REGISTRY.prepare(
      "INSERT INTO activities (activity_id, started_at, timezone, sport, duration_s, created_at, updated_at) VALUES (?1, '2018-07-01T14:00:00.000Z', 'America/Los_Angeles', 'ride', 3600, ?2, ?2)",
    ).bind(activityId, now),
    env.REGISTRY.prepare(
      "INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at) VALUES ('strava', ?1, ?2, ?3, ?4, ?4)",
    ).bind(sourceId, activityId, rawKeys, now),
  ]);
}

beforeEach(async () => {
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
    env.REGISTRY.prepare("DELETE FROM photo_backfill_targets"),
  ]);
});

describe("backfillStravaStreams", () => {
  it("enqueues a refresh for a row carrying no archived bytes", async () => {
    await seed("101", "{}");
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaStreams(testEnv(queue));

    expect(queue.messages).toEqual([
      { source: "strava", kind: "refresh", objectId: 101 },
    ]);
    expect(result).toEqual({ enqueued: 1, remaining: 1, done: true });
  });

  it("skips a row that already has an export original", async () => {
    await seed("101", '{"original":"raw/strava/activities/101/original.fit"}');
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaStreams(testEnv(queue));

    expect(queue.messages).toEqual([]);
    expect(result.enqueued).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it("skips a row that already has streams", async () => {
    await seed("101", '{"streams":"raw/strava/activities/101/streams.json"}');
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaStreams(testEnv(queue));

    expect(queue.messages).toEqual([]);
    expect(result.enqueued).toBe(0);
  });

  it("skips a soft-deleted row", async () => {
    await seed("101", "{}");
    await env.REGISTRY.prepare(
      "UPDATE activity_sources SET deleted_at = ?1 WHERE source_id = '101'",
    )
      .bind(new Date().toISOString())
      .run();
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaStreams(testEnv(queue));

    expect(queue.messages).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  it("hands back a cursor when the gap outruns one run", async () => {
    await seed("101", "{}");
    await seed("102", "{}");
    await seed("103", "{}");
    const queue = stubQueue<StravaIngestMessage>();

    const first = await backfillStravaStreams(testEnv(queue), { perRun: 2 });

    expect(queue.messages.map((message) => message.objectId)).toEqual([
      101, 102,
    ]);
    expect(first).toEqual({
      enqueued: 2,
      remaining: 3,
      done: false,
      nextCursor: "102",
    });
  });

  it("resumes after the cursor without repeating work", async () => {
    await seed("101", "{}");
    await seed("102", "{}");
    await seed("103", "{}");
    const queue = stubQueue<StravaIngestMessage>();

    const second = await backfillStravaStreams(testEnv(queue), {
      perRun: 2,
      cursor: "102",
    });

    expect(queue.messages.map((message) => message.objectId)).toEqual([103]);
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBeUndefined();
  });

  it("reports remaining as the whole gap, not the page", async () => {
    for (const id of ["101", "102", "103", "104"]) {
      await seed(id, "{}");
    }
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaStreams(testEnv(queue), { perRun: 1 });

    expect(result.enqueued).toBe(1);
    expect(result.remaining).toBe(4);
  });
});

describe("backfillStravaPhotos", () => {
  it("enqueues a refresh for a row with no archived photo", async () => {
    await seed("101", '{"detail":"raw/strava/activities/101/detail.json"}');
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaPhotos(testEnv(queue));

    expect(queue.messages).toEqual([
      { source: "strava", kind: "refresh", objectId: 101 },
    ]);
    expect(result).toEqual({ enqueued: 1, remaining: 1, done: true });
  });

  // The webhook path records the prefix under one key.
  it("skips a row whose photos arrived through a webhook", async () => {
    await seed("101", '{"photos":"raw/strava/activities/101/photos/"}');
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaPhotos(testEnv(queue));

    expect(queue.messages).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  // The bulk import records one key per file instead.
  it("skips a row whose photos came out of the bulk import", async () => {
    await seed(
      "101",
      '{"photos/IMG_1.jpg":"raw/strava/export/photos/IMG_1.jpg"}',
    );
    const queue = stubQueue<StravaIngestMessage>();

    const result = await backfillStravaPhotos(testEnv(queue));

    expect(queue.messages).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  it("walks the gap in pages the caller drives", async () => {
    await seed("101", "{}");
    await seed("102", "{}");
    await seed("103", "{}");
    const queue = stubQueue<StravaIngestMessage>();

    const first = await backfillStravaPhotos(testEnv(queue), { perRun: 2 });

    expect(first).toEqual({
      enqueued: 2,
      remaining: 3,
      done: false,
      nextCursor: "102",
    });
  });
});

async function targetIds(): Promise<string[]> {
  const { results } = await env.REGISTRY.prepare(
    "SELECT source_id FROM photo_backfill_targets ORDER BY source_id",
  ).all<{ source_id: string }>();
  return results.map((row) => row.source_id);
}

describe("seedPhotoBackfillTargets", () => {
  it("records the ids it was handed", async () => {
    const result = await seedPhotoBackfillTargets(testEnv(stubQueue()), [
      "101",
      "102",
    ]);

    expect(result).toEqual({ added: 2, alreadyPresent: 0, pending: 2 });
    expect(await targetIds()).toEqual(["101", "102"]);
  });

  // The id file goes up in pages, and a page resent after a failed request has
  // to be free rather than double-counted.
  it("is idempotent on a page that already landed", async () => {
    await seedPhotoBackfillTargets(testEnv(stubQueue()), ["101", "102"]);

    const result = await seedPhotoBackfillTargets(testEnv(stubQueue()), [
      "102",
      "103",
    ]);

    expect(result).toEqual({ added: 1, alreadyPresent: 1, pending: 3 });
    expect(await targetIds()).toEqual(["101", "102", "103"]);
  });

  it("counts a repeated id once", async () => {
    const result = await seedPhotoBackfillTargets(testEnv(stubQueue()), [
      "101",
      "101",
    ]);

    expect(result).toEqual({ added: 1, alreadyPresent: 0, pending: 1 });
  });
});

describe("drainPhotoBackfillTargets", () => {
  it("enqueues photos messages and spends the targets it took", async () => {
    await seed("101", "{}");
    await seed("102", "{}");
    await seedPhotoBackfillTargets(testEnv(stubQueue()), ["101", "102"]);
    const queue = stubQueue<StravaIngestMessage>();

    const result = await drainPhotoBackfillTargets(testEnv(queue));

    expect(queue.messages).toEqual([
      { source: "strava", kind: "photos", objectId: 101 },
      { source: "strava", kind: "photos", objectId: 102 },
    ]);
    expect(result).toEqual({ enqueued: 2, dropped: 0, pending: 0 });
    expect(await targetIds()).toEqual([]);
  });

  it("takes at most PHOTO_DRAIN targets per run", async () => {
    const ids = Array.from({ length: PHOTO_DRAIN + 2 }, (_, index) =>
      String(1000 + index),
    );
    for (const id of ids) {
      await seed(id, "{}");
    }
    await seedPhotoBackfillTargets(testEnv(stubQueue()), ids);
    const queue = stubQueue<StravaIngestMessage>();

    const result = await drainPhotoBackfillTargets(testEnv(queue));

    expect(result).toEqual({ enqueued: PHOTO_DRAIN, dropped: 0, pending: 2 });
    expect(await targetIds()).toEqual(ids.slice(PHOTO_DRAIN));
  });

  // An id archived through the webhook path since the list was seeded costs a
  // query to drop here rather than a Strava read to rediscover.
  it("drops a target that gained photos by another path", async () => {
    await seed("101", '{"photos":"raw/strava/activities/101/photos/"}');
    await seed("102", "{}");
    await seedPhotoBackfillTargets(testEnv(stubQueue()), ["101", "102"]);
    const queue = stubQueue<StravaIngestMessage>();

    const result = await drainPhotoBackfillTargets(testEnv(queue));

    expect(queue.messages).toEqual([
      { source: "strava", kind: "photos", objectId: 102 },
    ]);
    expect(result).toEqual({ enqueued: 1, dropped: 1, pending: 0 });
    expect(await targetIds()).toEqual([]);
  });

  it("is a no-op once the table is empty", async () => {
    const queue = stubQueue<StravaIngestMessage>();

    const result = await drainPhotoBackfillTargets(testEnv(queue));

    expect(queue.messages).toEqual([]);
    expect(result).toEqual({ enqueued: 0, dropped: 0, pending: 0 });
  });
});
