import { describe, expect, it } from "vitest";
import { matchActivity, type MatchCandidate, type MatchInput } from "./match";
import type { Sport } from "./sport";

const START = "2026-07-01T14:00:00.000Z";

function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return { startedAt: START, sport: "ride", durationS: 3600, ...overrides };
}

function candidate(
  activityId: string,
  overrides: Partial<MatchInput> = {},
): MatchCandidate {
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
    const existing = candidate("a", { startedAt: offset(120) });
    expect(matchActivity(input(), [existing])).toBe(existing);
  });

  it("mints just over the start delta threshold", () => {
    const existing = candidate("a", { startedAt: offset(121) });
    expect(matchActivity(input(), [existing])).toBeNull();
  });

  it("matches at exactly the duration ratio threshold", () => {
    const existing = candidate("a", { durationS: 950 });
    expect(matchActivity(input({ durationS: 1000 }), [existing])).toBe(
      existing,
    );
  });

  it("mints just over the duration ratio threshold", () => {
    const existing = candidate("a", { durationS: 949 });
    expect(matchActivity(input({ durationS: 1000 }), [existing])).toBeNull();
  });

  it("applies the duration ratio symmetrically", () => {
    const shorter = input({ durationS: 950 });
    const longer = candidate("a", { durationS: 1000 });
    expect(matchActivity(shorter, [longer])).toBe(longer);
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

  it("treats zero durations as matching", () => {
    const existing = candidate("a", { durationS: 0 });
    expect(matchActivity(input({ durationS: 0 }), [existing])).toBe(existing);
  });

  it("breaks ties by smallest start delta", () => {
    const near = candidate("near", { startedAt: offset(-10) });
    const far = candidate("far", { startedAt: offset(30) });
    expect(matchActivity(input(), [far, near])).toBe(near);
  });

  it.each<Sport>(["ride", "run", "walk", "hike", "swim", "strength"])(
    "matches %s against the same sport",
    (sport) => {
      const existing = candidate("a", { sport });
      expect(matchActivity(input({ sport }), [existing])).toBe(existing);
    },
  );
});
