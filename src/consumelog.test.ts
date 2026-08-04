import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendConsumeLog,
  consumeLogEntry,
  readConsumeLog,
} from "./consumelog";
import type { IngestMessage } from "./ingest";

const KEY = "debug:consume-log";

const wahooMessage: IngestMessage = {
  source: "wahoo",
  kind: "workout",
  workoutId: 101,
  workout: {},
};

const stravaMessage: IngestMessage = {
  source: "strava",
  kind: "refresh",
  objectId: 202,
};

beforeEach(async () => {
  await env.TOKENS.delete(KEY);
});

describe("consumeLogEntry", () => {
  it("uses the workout id for a Wahoo message", () => {
    expect(consumeLogEntry(wahooMessage, "ok")).toMatchObject({
      source: "wahoo",
      kind: "workout",
      id: 101,
      outcome: "ok",
    });
  });

  it("uses the object id for a Strava message", () => {
    expect(consumeLogEntry(stravaMessage, "ok")).toMatchObject({
      source: "strava",
      kind: "refresh",
      id: 202,
    });
  });
});

describe("appendConsumeLog", () => {
  it("appends entries in order across writes", async () => {
    await appendConsumeLog(env.TOKENS, [consumeLogEntry(wahooMessage, "ok")]);
    await appendConsumeLog(env.TOKENS, [
      consumeLogEntry(stravaMessage, "error: boom"),
    ]);

    const entries = await readConsumeLog(env.TOKENS);
    expect(entries.map((entry) => entry.id)).toEqual([101, 202]);
    expect(entries[1]?.outcome).toBe("error: boom");
  });

  it("keeps only the newest entries past the limit", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      ...consumeLogEntry(wahooMessage, "ok"),
      id: i,
    }));
    await appendConsumeLog(env.TOKENS, entries);

    const stored = await readConsumeLog(env.TOKENS);
    expect(stored).toHaveLength(200);
    expect(stored[0]?.id).toBe(50);
    expect(stored[199]?.id).toBe(249);
  });

  it("writes nothing for an empty batch", async () => {
    await appendConsumeLog(env.TOKENS, []);
    expect(await env.TOKENS.get(KEY)).toBeNull();
  });
});

describe("readConsumeLog", () => {
  it("returns an empty list for malformed contents", async () => {
    await env.TOKENS.put(KEY, "not json");
    expect(await readConsumeLog(env.TOKENS)).toEqual([]);
  });
});
