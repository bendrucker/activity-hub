import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SECRETS } from "../../test/secrets";
import {
  ARTIFACT_VERSION,
  EMPTY_FINGERPRINT,
  inputFingerprint,
  type DerivedStatus,
  type Stage,
} from "../derived";
import { consumeTransformBatch, type TransformMessage } from "./consume";
import type {
  DecodeOutcome,
  DecodeRequest,
  DecodeResponse,
  PublishArtifact,
  PublishRequest,
  PublishResponse,
} from "./protocol";
import type { SitePublisher } from "./publish";

const testEnv: Env = { ...env, ...SECRETS };

const OLD = "2026-01-01T00:00:00.000Z";
const RETRY = { delaySeconds: 60 };

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
}

async function seedSource(seed: SeedSource): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO activity_sources (source, source_id, activity_id, raw_keys, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)`,
  )
    .bind(
      seed.source,
      seed.sourceId,
      seed.activityId,
      JSON.stringify(seed.rawKeys ?? {}),
      OLD,
    )
    .run();
}

interface SeedDerived {
  activityId: string;
  stage: Stage;
  status: DerivedStatus;
  fingerprint?: string;
  outputKey?: string;
  attempts?: number;
  updatedAt?: string;
}

async function seedDerived(seed: SeedDerived): Promise<void> {
  await env.REGISTRY.prepare(
    `INSERT INTO derived (activity_id, stage, input_fingerprint, output_key, status, attempts, error, updated_at, artifact_version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)`,
  )
    .bind(
      seed.activityId,
      seed.stage,
      seed.fingerprint ?? "fingerprint",
      seed.outputKey ?? null,
      seed.status,
      seed.attempts ?? 0,
      seed.updatedAt ?? OLD,
      ARTIFACT_VERSION[seed.stage],
    )
    .run();
}

// An activity whose original bytes are archived, one source per key.
async function seedArchived(
  activityId: string,
  ...rawKeys: string[]
): Promise<void> {
  await seedActivity(activityId);
  for (const [index, key] of rawKeys.entries()) {
    await env.RAW.put(key, `bytes of ${key}`);
    await seedSource({
      source: "wahoo",
      sourceId: `${activityId}-${index}`,
      activityId,
      rawKeys: { original: key },
    });
  }
}

interface DerivedRow {
  input_fingerprint: string;
  output_key: string | null;
  status: string;
  attempts: number;
  error: string | null;
  updated_at: string;
}

function derivedRow(activityId: string): Promise<DerivedRow | null> {
  return env.REGISTRY.prepare(
    `SELECT input_fingerprint, output_key, status, attempts, error, updated_at
     FROM derived
     WHERE activity_id = ?1 AND stage = 'decode'`,
  )
    .bind(activityId)
    .first<DerivedRow>();
}

async function derivedCount(): Promise<number> {
  const row = await env.REGISTRY.prepare(
    "SELECT COUNT(*) AS count FROM derived",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

function stubMessage(body: TransformMessage) {
  return {
    id: `${body.activityId}-${body.stage}`,
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function decodeMessage(activityId: string) {
  return stubMessage({ activityId, stage: "decode" });
}

function batchOf(messages: ReturnType<typeof stubMessage>[]) {
  return {
    queue: "activity-hub-transform",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<TransformMessage>;
}

type Decode = (request: DecodeRequest) => Promise<DecodeResponse>;

function decodeReturning(...outcomes: DecodeOutcome[]) {
  return vi.fn<Decode>(() => Promise.resolve({ outcomes }));
}

function decodeRejecting(error: Error) {
  return vi.fn<Decode>(() => Promise.reject(error));
}

function decoded(activityId: string, errors: string[] = []): DecodeOutcome {
  return {
    activityId,
    status: "ok",
    outputKey: `decode/v1/${activityId}/`,
    rawKey: `raw/strava/activities/${activityId}/original.fit.gz`,
    records: 3600,
    laps: 1,
    sessions: 1,
    errors,
  };
}

const EMPTY_SUMMARY = {
  decoded: 0,
  published: 0,
  current: 0,
  skipped: 0,
  failed: 0,
  retried: 0,
};

beforeEach(async () => {
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("DELETE FROM derived"),
    env.REGISTRY.prepare("DELETE FROM activity_sources"),
    env.REGISTRY.prepare("DELETE FROM activities"),
  ]);
  const listed = await env.RAW.list({ prefix: "raw/test/" });
  await Promise.all(listed.objects.map((object) => env.RAW.delete(object.key)));
});

describe("consumeTransformBatch", () => {
  it("decodes an activity that has no derived row", async () => {
    await seedArchived("a1", "raw/test/a1.fit");
    const message = decodeMessage("a1");
    const decode = decodeReturning(decoded("a1"));

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      client: { decode },
    });

    expect(decode).toHaveBeenCalledWith({
      work: [{ activityId: "a1", rawKeys: ["raw/test/a1.fit"] }],
    });
    expect(await derivedRow("a1")).toMatchObject({
      status: "ok",
      output_key: "decode/v1/a1/",
      error: null,
      attempts: 0,
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, decoded: 1 });
  });

  it("leaves an activity alone when its fingerprint already decoded", async () => {
    await seedArchived("a1", "raw/test/a1.fit");
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "ok",
      fingerprint: await inputFingerprint(env.RAW, ["raw/test/a1.fit"]),
      outputKey: "decode/v1/a1/",
    });
    const message = decodeMessage("a1");
    const decode = decodeReturning();

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      client: { decode },
    });

    expect(decode).not.toHaveBeenCalled();
    expect(await derivedRow("a1")).toMatchObject({
      output_key: "decode/v1/a1/",
      updated_at: OLD,
    });
    expect(message.ack).toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, current: 1 });
  });

  it("skips an activity with no archived original", async () => {
    await seedActivity("a1");
    await seedSource({
      source: "strava",
      sourceId: "1",
      activityId: "a1",
      rawKeys: { summary: "raw/test/a1.json" },
    });
    const message = decodeMessage("a1");
    const decode = decodeReturning();

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      client: { decode },
    });

    expect(decode).not.toHaveBeenCalled();
    expect(await derivedRow("a1")).toMatchObject({
      status: "skipped",
      input_fingerprint: EMPTY_FINGERPRINT,
      output_key: null,
      error: "activity has no archived original",
    });
    expect(message.ack).toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, skipped: 1 });
  });

  it("records a failed decode without retrying the message", async () => {
    // The container answered about this activity, so redelivering it only
    // re-runs a decode that already has its verdict. The attempt ceiling on the
    // derived row is what eventually parks it.
    await seedArchived("a1", "raw/test/a1.fit");
    // The prior row has to carry the fingerprint this run computes, or the
    // budget restarts instead of incrementing. Same input, third strike.
    await seedDerived({
      activityId: "a1",
      stage: "decode",
      status: "failed",
      fingerprint: await inputFingerprint(env.RAW, ["raw/test/a1.fit"]),
      attempts: 2,
    });
    const message = decodeMessage("a1");
    const decode = decodeReturning({
      activityId: "a1",
      status: "failed",
      error: "unsupported FIT profile",
    });

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      client: { decode },
    });

    expect(await derivedRow("a1")).toMatchObject({
      status: "failed",
      error: "unsupported FIT profile",
      attempts: 3,
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, failed: 1 });
  });

  it("retries the whole batch when the container errors", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedArchived("a1", "raw/test/a1.fit");
    await seedArchived("a2", "raw/test/a2.fit");
    const messages = [decodeMessage("a1"), decodeMessage("a2")];
    const decode = decodeRejecting(new Error("container unreachable"));

    const summary = await consumeTransformBatch(batchOf(messages), testEnv, {
      client: { decode },
    });

    for (const message of messages) {
      expect(message.retry).toHaveBeenCalledWith(RETRY);
      expect(message.ack).not.toHaveBeenCalled();
    }
    expect(await derivedCount()).toBe(0);
    expect(summary).toEqual({ ...EMPTY_SUMMARY, retried: 2 });
    logged.mockRestore();
  });

  it("retries only the activity the container answered nothing for", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedArchived("a1", "raw/test/a1.fit");
    await seedArchived("a2", "raw/test/a2.fit");
    const answered = decodeMessage("a1");
    const ignored = decodeMessage("a2");
    const decode = decodeReturning(decoded("a1"));

    const summary = await consumeTransformBatch(
      batchOf([answered, ignored]),
      testEnv,
      { client: { decode } },
    );

    expect(await derivedRow("a1")).toMatchObject({ status: "ok" });
    expect(answered.ack).toHaveBeenCalled();
    expect(await derivedRow("a2")).toBeNull();
    expect(ignored.retry).toHaveBeenCalledWith(RETRY);
    expect(ignored.ack).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, decoded: 1, retried: 1 });
    logged.mockRestore();
  });

  it("decodes an activity once however many messages ask for it", async () => {
    await seedArchived("a1", "raw/test/a1.fit");
    const messages = [decodeMessage("a1"), decodeMessage("a1")];
    const decode = decodeReturning(decoded("a1"));

    const summary = await consumeTransformBatch(batchOf(messages), testEnv, {
      client: { decode },
    });

    expect(decode).toHaveBeenCalledWith({
      work: [{ activityId: "a1", rawKeys: ["raw/test/a1.fit"] }],
    });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(summary).toEqual({ ...EMPTY_SUMMARY, decoded: 1 });
  });

  it("drops a message for a stage with no per-activity grain", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedArchived("a1", "raw/test/a1.fit");
    const message = stubMessage({ activityId: "a1", stage: "lake" });
    const decode = decodeReturning();

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      client: { decode },
    });

    expect(decode).not.toHaveBeenCalled();
    expect(await derivedCount()).toBe(0);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(summary).toEqual(EMPTY_SUMMARY);
    logged.mockRestore();
  });

  it("carries non-fatal decode errors onto a successful row", async () => {
    await seedArchived("a1", "raw/test/a1.fit");
    const message = decodeMessage("a1");
    const decode = decodeReturning(
      decoded("a1", ["dropped 3 records", "power stream ends early"]),
    );

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      client: { decode },
    });

    expect(await derivedRow("a1")).toMatchObject({
      status: "ok",
      output_key: "decode/v1/a1/",
      error: "dropped 3 records; power stream ends early",
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, decoded: 1 });
  });

  it("enqueues publish once an activity decodes", async () => {
    await seedArchived("a1", "raw/test/a1.fit");
    const send = vi.spyOn(testEnv.TRANSFORM_QUEUE, "send");

    await consumeTransformBatch(batchOf([decodeMessage("a1")]), testEnv, {
      client: { decode: decodeReturning(decoded("a1")) },
    });

    expect(send).toHaveBeenCalledWith({
      activityId: "a1",
      stage: "publish",
    });
    send.mockRestore();
  });
});

class ValidationError extends Error {
  override readonly name = "ValidationError";
}

function artifact(overrides: Partial<PublishArtifact> = {}): PublishArtifact {
  return {
    polyline: "_p~iF~ps|U",
    elevationProfile: [10, 20, 30],
    averageWatts: 210,
    powerSource: "measured",
    bests: [{ durationS: 5, watts: 400 }],
    distanceM: 42000,
    elevationM: 500,
    movingS: 5400,
    ...overrides,
  };
}

function summarizeReturning(response: PublishResponse) {
  return vi.fn<(request: PublishRequest) => Promise<PublishResponse>>(() =>
    Promise.resolve(response),
  );
}

function siteStub(overrides: Partial<SitePublisher> = {}) {
  return {
    publishActivity: vi.fn(() => Promise.resolve()),
    publishPowerCurve: vi.fn(() => Promise.resolve()),
    deleteActivity: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function publishMessage(activityId: string) {
  return stubMessage({ activityId, stage: "publish" });
}

function publishRow(activityId: string): Promise<DerivedRow | null> {
  return env.REGISTRY.prepare(
    `SELECT input_fingerprint, output_key, status, attempts, error, updated_at
     FROM derived
     WHERE activity_id = ?1 AND stage = 'publish'`,
  )
    .bind(activityId)
    .first<DerivedRow>();
}

// A Strava activity with an archived detail body and two photos, decoded.
async function seedPublishable(activityId: string): Promise<void> {
  await seedActivity(activityId);
  await env.RAW.put(
    "raw/test/detail.json",
    JSON.stringify({
      name: "Kings Mountain",
      distance: 41000,
      moving_time: 5000,
      total_elevation_gain: 480,
    }),
  );
  await env.RAW.put("raw/test/photos/one.jpg", "one");
  await env.RAW.put("raw/test/photos/two.jpg", "two");
  await seedSource({
    source: "strava",
    sourceId: "9001",
    activityId,
    rawKeys: {
      detail: "raw/test/detail.json",
      photos: "raw/test/photos/",
    },
  });
  await seedDerived({
    activityId,
    stage: "decode",
    status: "ok",
    outputKey: `decode/v1/${activityId}/`,
  });
}

// The publish fingerprint is the decode row's, so it moves when the bytes
// change or the decoder does, and stands still otherwise.
const PUBLISHED = `fingerprint:${ARTIFACT_VERSION.decode}`;

describe("the publish stage", () => {
  it("assembles the row from the registry, the archive, and the container", async () => {
    await seedPublishable("a1");
    const site = siteStub();
    const summarize = summarizeReturning({
      outcome: { activityId: "a1", status: "ok", artifact: artifact() },
    });

    const summary = await consumeTransformBatch(
      batchOf([publishMessage("a1")]),
      testEnv,
      { container: { summarize }, site },
    );

    expect(summarize).toHaveBeenCalledWith({
      work: {
        activityId: "a1",
        decode: "s3://activity-hub-lake/decode/v1/a1/",
      },
    });
    expect(site.publishActivity).toHaveBeenCalledWith({
      activityId: "a1",
      stravaId: "9001",
      name: "Kings Mountain",
      sport: "ride",
      startedAt: "2026-01-01T14:00:00.000Z",
      timezone: "America/Los_Angeles",
      distanceM: 42000,
      movingS: 5400,
      elevationM: 500,
      averageWatts: 210,
      powerSource: "measured",
      polyline: "_p~iF~ps|U",
      elevationProfile: [10, 20, 30],
      photoKeys: ["raw/test/photos/one.jpg", "raw/test/photos/two.jpg"],
    });
    expect(site.publishPowerCurve).toHaveBeenCalledWith("a1", [
      { durationS: 5, watts: 400 },
    ]);
    expect(await publishRow("a1")).toMatchObject({
      status: "ok",
      input_fingerprint: PUBLISHED,
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, published: 1 });
  });

  // Strava's numbers stand in where the device recorded no session summary,
  // which is every GPX file and any FIT the ride was cut short of writing.
  it("falls back to the provider's totals when the device wrote none", async () => {
    await seedPublishable("a1");
    const site = siteStub();

    await consumeTransformBatch(batchOf([publishMessage("a1")]), testEnv, {
      container: {
        summarize: summarizeReturning({
          outcome: {
            activityId: "a1",
            status: "ok",
            artifact: artifact({
              distanceM: null,
              elevationM: null,
              movingS: null,
            }),
          },
        }),
      },
      site,
    });

    expect(site.publishActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        distanceM: 41000,
        movingS: 5000,
        elevationM: 480,
      }),
    );
  });

  // The site rejecting the row's shape is the one failure a retry cannot fix,
  // and the error's name is all that crosses the RPC boundary to say so.
  it("parks a row the site rejects instead of retrying it", async () => {
    await seedPublishable("a1");
    const message = publishMessage("a1");
    const site = siteStub({
      publishActivity: vi.fn(() =>
        Promise.reject(new ValidationError("sport is required")),
      ),
    });

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      container: {
        summarize: summarizeReturning({
          outcome: { activityId: "a1", status: "ok", artifact: artifact() },
        }),
      },
      site,
    });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await publishRow("a1")).toMatchObject({
      status: "failed",
      error: "sport is required",
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, failed: 1 });
  });

  it("retries when the site is unreachable", async () => {
    await seedPublishable("a1");
    const message = publishMessage("a1");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const site = siteStub({
      publishActivity: vi.fn(() =>
        Promise.reject(new Error("Network connection lost")),
      ),
    });

    const summary = await consumeTransformBatch(batchOf([message]), testEnv, {
      container: {
        summarize: summarizeReturning({
          outcome: { activityId: "a1", status: "ok", artifact: artifact() },
        }),
      },
      site,
    });

    expect(message.retry).toHaveBeenCalledWith(RETRY);
    expect(await publishRow("a1")).toBeNull();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, retried: 1 });
    logged.mockRestore();
  });

  it("records a failure the container attributes to the artifact", async () => {
    await seedPublishable("a1");
    const site = siteStub();

    const summary = await consumeTransformBatch(
      batchOf([publishMessage("a1")]),
      testEnv,
      {
        container: {
          summarize: summarizeReturning({
            outcome: {
              activityId: "a1",
              status: "failed",
              error: "No files found that match the pattern",
            },
          }),
        },
        site,
      },
    );

    expect(site.publishActivity).not.toHaveBeenCalled();
    expect(await publishRow("a1")).toMatchObject({
      status: "failed",
      error: "No files found that match the pattern",
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, failed: 1 });
  });

  it("skips an activity that has not been decoded", async () => {
    await seedActivity("a1");
    await seedSource({ source: "wahoo", sourceId: "1", activityId: "a1" });
    const summarize = summarizeReturning({
      outcome: { activityId: "a1", status: "ok", artifact: artifact() },
    });

    const summary = await consumeTransformBatch(
      batchOf([publishMessage("a1")]),
      testEnv,
      { container: { summarize }, site: siteStub() },
    );

    expect(summarize).not.toHaveBeenCalled();
    expect(await publishRow("a1")).toMatchObject({
      status: "skipped",
      error: "activity has not been decoded",
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, skipped: 1 });
  });

  // A deleted activity drops out of the staleness query at the same moment it
  // stops having live sources, so this message is the only thing that will
  // ever take the row off the site.
  it("deletes an activity whose sources are all gone", async () => {
    await seedPublishable("a1");
    await env.REGISTRY.prepare(
      "UPDATE activity_sources SET deleted_at = ?1 WHERE activity_id = 'a1'",
    )
      .bind(OLD)
      .run();
    const site = siteStub();

    const summary = await consumeTransformBatch(
      batchOf([publishMessage("a1")]),
      testEnv,
      {
        container: { summarize: summarizeReturning({} as PublishResponse) },
        site,
      },
    );

    expect(site.deleteActivity).toHaveBeenCalledWith("a1");
    expect(site.publishActivity).not.toHaveBeenCalled();
    expect(await publishRow("a1")).toMatchObject({ status: "ok" });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, published: 1 });
  });

  it("leaves a published activity alone until its decode artifact moves", async () => {
    await seedPublishable("a1");
    await seedDerived({
      activityId: "a1",
      stage: "publish",
      status: "ok",
      fingerprint: PUBLISHED,
    });
    const summarize = summarizeReturning({
      outcome: { activityId: "a1", status: "ok", artifact: artifact() },
    });
    const site = siteStub();

    const summary = await consumeTransformBatch(
      batchOf([publishMessage("a1")]),
      testEnv,
      { container: { summarize }, site },
    );

    expect(summarize).not.toHaveBeenCalled();
    expect(site.publishActivity).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, current: 1 });
  });
});
