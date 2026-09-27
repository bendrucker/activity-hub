import { describe, expect, it } from "vitest";
import { matchActivity, type MatchCandidate, type MatchInput } from "./match";
import type { Sport } from "./sport";

const START = "2026-07-01T14:00:00.000Z";

function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return { startedAt: START, sport: "ride", durationS: 3600, ...overrides };
}

function candidate(activityId: string, overrides: Partial<MatchInput> = {}): MatchCandidate {
  return { activityId, ...input(overrides) };
}

function offset(seconds: number): string {
  return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

describe("matchActivity", () => {
  it("returns null with no candidates", () => {
    expect(matchActivity(input(), [])).toBeNull();
  });

  it("matches an identical activity", () => {
    const existing = candidate("a");
    expect(matchActivity(input(), [existing])).toBe(existing);
  });

  it("matches at exactly the start delta threshold", () => {
    const existing = candidate("a", { startedAt: offset(900) });
    expect(matchActivity(input(), [existing])).toBe(existing);
  });

  it("mints just over the start delta threshold", () => {
    const existing = candidate("a", { startedAt: offset(901) });
    expect(matchActivity(input(), [existing])).toBeNull();
  });

  it("mints when an earlier recording ended before the candidate started", () => {
    const aborted = candidate("a", { startedAt: offset(-300), durationS: 300 });
    expect(matchActivity(input(), [aborted])).toBeNull();
  });

  it("mints when the candidate ended before a later recording started", () => {
    const later = candidate("a", { startedAt: offset(600) });
    expect(matchActivity(input({ durationS: 600 }), [later])).toBeNull();
  });

  it("matches a Wahoo recording that ran on while paused", () => {
    // Tres: Wahoo total 71017 s, Strava elapsed 58177 s, same start.
    const strava = candidate("a", { durationS: 58177 });
    expect(matchActivity(input({ durationS: 71017 }), [strava])).toBe(strava);
  });

  it("matches a ride cropped on Strava", () => {
    // Caltrain: the unit ran for hours after a 26 minute ride.
    const strava = candidate("a", { durationS: 1570 });
    expect(matchActivity(input({ durationS: 42788 }), [strava])).toBe(strava);
  });

  it("matches a Strava start minutes after the Wahoo start", () => {
    const strava = candidate("a", { startedAt: offset(710), durationS: 5440 });
    expect(matchActivity(input({ durationS: 6151 }), [strava])).toBe(strava);
  });

  it("never matches a zero-duration recording", () => {
    const existing = candidate("a");
    expect(matchActivity(input({ durationS: 0 }), [existing])).toBeNull();
    expect(matchActivity(input(), [candidate("b", { durationS: 0 })])).toBeNull();
  });

  it("mints on sport mismatch", () => {
    const existing = candidate("a", { sport: "run" });
    expect(matchActivity(input(), [existing])).toBeNull();
  });

  it("matches other only with other", () => {
    const other = candidate("a", { sport: "other" });
    expect(matchActivity(input({ sport: "other" }), [other])).toBe(other);
    expect(matchActivity(input({ sport: "ride" }), [other])).toBeNull();
  });

  it("breaks ties by smallest start delta", () => {
    const near = candidate("near", { startedAt: offset(-10) });
    const far = candidate("far", { startedAt: offset(30) });
    expect(matchActivity(input(), [far, near])).toBe(near);
  });

  it("breaks start ties by closest duration", () => {
    const short = candidate("short", { durationS: 1901 });
    const long = candidate("long", { durationS: 4012 });
    expect(matchActivity(input({ durationS: 2897 }), [long, short])).toBe(short);
  });

  it.each<Sport>(["ride", "run", "walk", "hike", "swim", "strength"])(
    "matches %s against the same sport",
    (sport) => {
      const existing = candidate("a", { sport });
      expect(matchActivity(input({ sport }), [existing])).toBe(existing);
    },
  );
});
