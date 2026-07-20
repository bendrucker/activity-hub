import { describe, expect, it } from "vitest";
import { inferTimezones, trackTimezone } from "./timezone";

describe("trackTimezone", () => {
  it("resolves the zone of the first point", () => {
    expect(trackTimezone([[37.7715, -122.4609]])).toBe("America/Los_Angeles");
    expect(trackTimezone([[40.7259, -74.0014]])).toBe("America/New_York");
  });

  it("returns null without points", () => {
    expect(trackTimezone([])).toBeNull();
  });
});

describe("inferTimezones", () => {
  it("keeps resolved zones untouched", () => {
    expect(
      inferTimezones(
        [{ startedAt: "2026-07-01T14:00:00.000Z", timezone: "America/Denver" }],
        "America/Los_Angeles",
      ),
    ).toEqual(["America/Denver"]);
  });

  it("fills gaps from the nearest-in-time resolved activity", () => {
    const zones = inferTimezones(
      [
        {
          startedAt: "2017-05-23T12:50:00.000Z",
          timezone: "America/New_York",
        },
        { startedAt: "2017-05-24T12:00:00.000Z", timezone: null },
        { startedAt: "2026-07-14T13:00:00.000Z", timezone: null },
        {
          startedAt: "2026-07-15T13:11:00.000Z",
          timezone: "America/Los_Angeles",
        },
      ],
      "UTC",
    );
    expect(zones).toEqual([
      "America/New_York",
      "America/New_York",
      "America/Los_Angeles",
      "America/Los_Angeles",
    ]);
  });

  it("breaks equidistant ties by input order", () => {
    const zones = inferTimezones(
      [
        { startedAt: "2026-07-01T00:00:00.000Z", timezone: "America/Chicago" },
        { startedAt: "2026-07-02T00:00:00.000Z", timezone: null },
        { startedAt: "2026-07-03T00:00:00.000Z", timezone: "America/Denver" },
      ],
      "UTC",
    );
    expect(zones[1]).toBe("America/Chicago");
  });

  it("falls back when nothing resolved a zone", () => {
    expect(
      inferTimezones(
        [{ startedAt: "2026-07-01T14:00:00.000Z", timezone: null }],
        "America/Los_Angeles",
      ),
    ).toEqual(["America/Los_Angeles"]);
  });
});
