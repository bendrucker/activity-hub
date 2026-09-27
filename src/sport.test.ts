import { describe, expect, it } from "vitest";
import {
  indoorFromFit,
  indoorFromStrava,
  indoorFromWahoo,
  sportFromStrava,
  sportFromWahoo,
} from "./sport";

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

describe("indoorFromStrava", () => {
  it.each<[string, boolean | undefined, boolean | null]>([
    ["VirtualRide", false, true],
    ["VirtualRide", undefined, true],
    ["Ride", true, true],
    ["Ride", false, false],
    ["Ride", undefined, null],
    ["GravelRide", false, false],
  ])("reads %s with trainer %s as %s", (sportType, trainer, expected) => {
    expect(indoorFromStrava(sportType, trainer)).toBe(expected);
  });
});

describe("indoorFromWahoo", () => {
  it.each([
    [12, true],
    [21, true],
    [49, true],
    [61, true],
    [68, true],
    [0, false],
    [15, false],
  ])("reads workout type %i as %s", (workoutTypeId, expected) => {
    expect(indoorFromWahoo(workoutTypeId)).toBe(expected);
  });
});

describe("indoorFromFit", () => {
  it.each([
    ["indoorCycling", true],
    ["virtualActivity", true],
    ["spin", true],
    ["generic", false],
    ["road", false],
  ])("reads sub_sport %s as %s", (subSport, expected) => {
    expect(indoorFromFit(subSport)).toBe(expected);
  });
});
