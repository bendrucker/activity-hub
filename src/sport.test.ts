import { describe, expect, it } from "vitest";
import { sportFromStrava, sportFromWahoo } from "./sport";

describe("sportFromStrava", () => {
  it.each([
    ["Ride", "ride"],
    ["GravelRide", "ride"],
    ["MountainBikeRide", "ride"],
    ["VirtualRide", "ride"],
    ["EBikeRide", "ride"],
    ["Run", "run"],
    ["TrailRun", "run"],
    ["VirtualRun", "run"],
    ["Walk", "walk"],
    ["Hike", "hike"],
    ["Swim", "swim"],
    ["WeightTraining", "strength"],
    ["Crossfit", "strength"],
    ["Pickleball", "other"],
    ["Yoga", "other"],
  ])("maps %s to %s", (sportType, expected) => {
    expect(sportFromStrava(sportType)).toBe(expected);
  });

  it("maps unknown sport types to other", () => {
    expect(sportFromStrava("NotARealSport")).toBe("other");
  });
});

describe("sportFromWahoo", () => {
  it.each([
    [0, "ride"], // BIKING
    [15, "ride"], // BIKING_ROAD
    [61, "ride"], // BIKING_INDOOR_TRAINER
    [68, "ride"], // BIKING_INDOOR_VIRTUAL
    [1, "run"], // RUNNING
    [5, "run"], // RUNNING_TREADMILL
    [6, "walk"], // WALKING
    [9, "hike"], // HIKING
    [25, "swim"], // SWIMMING_LAP
    [26, "swim"], // SWIMMING_OPEN_WATER
    [42, "strength"], // WORKOUT
    [17, "other"], // BIKING_MOTOCYCLING (motorized)
    [47, "other"], // OTHER
    [255, "other"], // UNKNOWN
  ])("maps %d to %s", (workoutTypeId, expected) => {
    expect(sportFromWahoo(workoutTypeId)).toBe(expected);
  });

  it("maps unknown workout type ids to other", () => {
    expect(sportFromWahoo(9999)).toBe("other");
  });
});
