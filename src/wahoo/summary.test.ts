import { describe, expect, it } from "vitest";
import {
  durationS,
  summarySourceRecord,
  syncStub,
  type WahooWorkoutSummary,
} from "./summary";

const SUMMARY: WahooWorkoutSummary = {
  id: 8297,
  duration_total_accum: "275.20",
  file: { url: "https://cdn.wahooligan.com/file/abc.fit" },
  workout: {
    id: 56519,
    starts: "2026-07-01T14:00:00.000Z",
    minutes: 12,
    workout_type_id: 0,
  },
};

describe("durationS", () => {
  it("rounds duration_total_accum seconds", () => {
    expect(durationS(SUMMARY)).toBe(275);
  });

  it("falls back to workout minutes when the accumulator is absent", () => {
    expect(durationS({ ...SUMMARY, duration_total_accum: undefined })).toBe(
      720,
    );
  });
});

describe("syncStub", () => {
  it("reads the app and its activity id out of the workout token", () => {
    expect(syncStub({ workout_token: "FID1085 19536737704:0" })).toEqual({
      app: "strava",
      foreignId: "19536737704",
    });
  });

  it("names an unrecognized app by its fitness_app_id", () => {
    expect(syncStub({ workout_token: "FID42 7:0" })).toEqual({
      app: "app 42",
      foreignId: "7",
    });
  });

  it("is null for a workout the device recorded", () => {
    expect(syncStub({ workout_token: "ELEMNT BOLT 511E:65" })).toBeNull();
  });

  it("is null for a workout with no token", () => {
    expect(syncStub({})).toBeNull();
  });
});

describe("summarySourceRecord", () => {
  it("maps the summary onto a SourceRecord", () => {
    const record = summarySourceRecord(
      SUMMARY,
      { timezone: "America/Los_Angeles", inferred: false },
      { summary: "raw/wahoo/workouts/56519/summary.json" },
    );
    expect(record).toEqual({
      source: "wahoo",
      sourceId: "56519",
      startedAt: "2026-07-01T14:00:00.000Z",
      timezone: "America/Los_Angeles",
      timezoneInferred: false,
      sport: "ride",
      durationS: 275,
      rawKeys: { summary: "raw/wahoo/workouts/56519/summary.json" },
    });
  });
});
