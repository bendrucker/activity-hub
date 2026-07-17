import { describe, expect, it } from "vitest";
import type { ExportActivity } from "./csv";
import { placeActivity, toSourceRecord } from "./placement";

function activity(overrides: Partial<ExportActivity> = {}): ExportActivity {
  return {
    sourceId: "19324502491",
    startedAt: "2026-07-15T13:11:54.000Z",
    sportType: "Ride",
    elapsedS: 6770,
    filename: "activities/20443348595.fit.gz",
    media: [],
    ...overrides,
  };
}

describe("placeActivity", () => {
  it("keys the original by activity ID with the full extension chain", () => {
    const placement = placeActivity(activity(), new Set());
    expect(placement.objects).toEqual([
      {
        key: "raw/strava/activities/19324502491/original.fit.gz",
        sourcePath: "activities/20443348595.fit.gz",
      },
    ]);
    expect(placement.rawKeys).toEqual({
      original: "raw/strava/activities/19324502491/original.fit.gz",
    });
  });

  it("places polylines under the derived prefix", () => {
    const placement = placeActivity(activity(), new Set());
    expect(placement.polylineKey).toBe(
      "derived/strava/activities/19324502491/polyline.json",
    );
  });

  it("mirrors only photos present in the archive", () => {
    const placement = placeActivity(
      activity({ media: ["media/present.jpg", "media/missing.jpg"] }),
      new Set(["media/present.jpg"]),
    );
    expect(placement.objects).toContainEqual({
      key: "raw/strava/activities/19324502491/photos/present.jpg",
      sourcePath: "media/present.jpg",
    });
    expect(placement.rawKeys["photos/present.jpg"]).toBeDefined();
    expect(placement.rawKeys["photos/missing.jpg"]).toBeUndefined();
  });

  it("produces no objects for file-less activities", () => {
    const placement = placeActivity(activity({ filename: null }), new Set());
    expect(placement.objects).toEqual([]);
    expect(placement.rawKeys).toEqual({});
  });
});

describe("toSourceRecord", () => {
  it("maps sport through the Strava table", () => {
    const record = toSourceRecord(
      activity({ sportType: "VirtualRide" }),
      "America/Los_Angeles",
      { original: "raw/strava/activities/19324502491/original.fit.gz" },
    );
    expect(record).toMatchObject({
      source: "strava",
      sourceId: "19324502491",
      sport: "ride",
      durationS: 6770,
      timezone: "America/Los_Angeles",
    });
  });

  it("maps unknown sport types to other", () => {
    const record = toSourceRecord(
      activity({ sportType: "Windsurf" }),
      "UTC",
      {},
    );
    expect(record.sport).toBe("other");
  });
});
