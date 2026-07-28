import { describe, expect, it } from "vitest";
import { parseActivitiesCsv, parseExportDate } from "./csv";

// The real export repeats several column names (Elapsed Time, Distance), and
// the later occurrence is sometimes empty where the first is populated.
const CSV = `Activity ID,Activity Date,Activity Type,Elapsed Time,Distance,Filename,Elapsed Time,Moving Time,Media
19324502491,"Jul 15, 2026, 1:11:54 PM",Ride,6770,21.5,activities/20443348595.fit.gz,6770.0,4484.0,media/e21b4ad8.jpg||
593377978,"Jul 3, 2013, 1:10:23 PM",Virtual Ride,553,2.1,activities/648066488.gpx,,474.0,
593378009,"Mar 20, 2013, 12:42:06 AM",E-Bike Ride,4095,30.0,,4095.0,3870.0,media/a.jpg|media/b.jpg|
`;

describe("parseExportDate", () => {
  it("parses export dates as UTC", () => {
    expect(parseExportDate("Jul 15, 2026, 1:11:54 PM")).toBe(
      "2026-07-15T13:11:54.000Z",
    );
  });

  it("handles the 12 o'clock edge cases", () => {
    expect(parseExportDate("Jan 1, 2020, 12:00:00 AM")).toBe(
      "2020-01-01T00:00:00.000Z",
    );
    expect(parseExportDate("Jan 1, 2020, 12:30:00 PM")).toBe(
      "2020-01-01T12:30:00.000Z",
    );
  });

  it("throws on unrecognized formats", () => {
    expect(() => parseExportDate("2026-07-15T13:11:54Z")).toThrow(
      "unparseable activity date",
    );
  });
});

describe("parseActivitiesCsv", () => {
  it("maps rows to export activities", () => {
    const [first] = parseActivitiesCsv(CSV);
    expect(first).toEqual({
      sourceId: "19324502491",
      startedAt: "2026-07-15T13:11:54.000Z",
      sportType: "Ride",
      elapsedS: 6770,
      filename: "activities/20443348595.fit.gz",
      media: ["media/e21b4ad8.jpg"],
    });
  });

  it("normalizes display sport names to API sport types", () => {
    const rows = parseActivitiesCsv(CSV);
    expect(rows.map((row) => row.sportType)).toEqual([
      "Ride",
      "VirtualRide",
      "EBikeRide",
    ]);
  });

  it("handles rows without files and multiple media entries", () => {
    const rows = parseActivitiesCsv(CSV);
    expect(rows[2]).toMatchObject({
      filename: null,
      media: ["media/a.jpg", "media/b.jpg"],
    });
  });
});
