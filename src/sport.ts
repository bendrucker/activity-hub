export type Sport = "ride" | "run" | "walk" | "hike" | "swim" | "strength" | "other";

const STRAVA_SPORTS: Record<string, Sport> = {
  Ride: "ride",
  GravelRide: "ride",
  MountainBikeRide: "ride",
  EBikeRide: "ride",
  EMountainBikeRide: "ride",
  VirtualRide: "ride",
  Velomobile: "ride",
  Handcycle: "ride",
  Run: "run",
  TrailRun: "run",
  VirtualRun: "run",
  Walk: "walk",
  Hike: "hike",
  Swim: "swim",
  WeightTraining: "strength",
  Crossfit: "strength",
};

export function sportFromStrava(sportType: string): Sport {
  return STRAVA_SPORTS[sportType] ?? "other";
}

// workout_type_id values from https://cloud-api.wahooligan.com/#workouts.
// 17 (BIKING_MOTOCYCLING) is motorized, so it maps to "other" despite the
// BIKING family.
const WAHOO_SPORTS: Record<number, Sport> = {
  0: "ride", // BIKING
  11: "ride", // BIKING_CYCLECROSS
  12: "ride", // BIKING_INDOOR
  13: "ride", // BIKING_MOUNTAIN
  14: "ride", // BIKING_RECUMBENT
  15: "ride", // BIKING_ROAD
  16: "ride", // BIKING_TRACK
  21: "ride", // FE_BIKE
  49: "ride", // BIKING_INDOOR_CYCLING_CLASS
  61: "ride", // BIKING_INDOOR_TRAINER
  64: "ride", // EBIKING
  68: "ride", // BIKING_INDOOR_VIRTUAL
  70: "ride", // HANDCYCLING
  1: "run", // RUNNING
  3: "run", // RUNNING_TRACK
  4: "run", // RUNNING_TRAIL
  5: "run", // RUNNING_TREADMILL
  19: "run", // FE_TREADMILL
  67: "run", // RUNNING_RACE
  71: "run", // RUNNING_INDOOR_VIRTUAL
  6: "walk", // WALKING
  7: "walk", // WALKING_SPEED
  8: "walk", // WALKING_NORDIC
  56: "walk", // WALKING_TREADMILL
  9: "hike", // HIKING
  10: "hike", // MOUNTAINEERING
  25: "swim", // SWIMMING_LAP
  26: "swim", // SWIMMING_OPEN_WATER
  42: "strength", // WORKOUT
};

export function sportFromWahoo(workoutTypeId: number): Sport {
  return WAHOO_SPORTS[workoutTypeId] ?? "other";
}

// Whether a source's own type says the activity happened indoors. The site
// leaves these out of every record, because a trainer's distance is a wheel
// sensor's guess and a virtual course's climbing happened in a game.
const STRAVA_INDOOR = new Set(["VirtualRide", "VirtualRun", "VirtualRow"]);

// Strava's `trainer` flag marks a ride on a trainer that the athlete left
// typed as a plain Ride, which the sport type alone cannot tell apart.
export function indoorFromStrava(sportType: string, trainer: boolean): boolean {
  return trainer || STRAVA_INDOOR.has(sportType);
}

// FE_BIKE and FE_TREADMILL are fitness equipment the head unit paired with,
// so they are indoor even though their names do not say so.
const WAHOO_INDOOR = new Set([
  5, // RUNNING_TREADMILL
  12, // BIKING_INDOOR
  19, // FE_TREADMILL
  21, // FE_BIKE
  49, // BIKING_INDOOR_CYCLING_CLASS
  56, // WALKING_TREADMILL
  61, // BIKING_INDOOR_TRAINER
  68, // BIKING_INDOOR_VIRTUAL
  71, // RUNNING_INDOOR_VIRTUAL
]);

export function indoorFromWahoo(workoutTypeId: number): boolean {
  return WAHOO_INDOOR.has(workoutTypeId);
}

// A FIT session's sub_sport, as the Garmin SDK decodes it. This is the only
// type a Garmin recording carries, and it is also how a Wahoo head unit marks
// a trainer ride that its workout type does not.
const FIT_INDOOR = new Set([
  "treadmill",
  "spin",
  "indoorCycling",
  "indoorRowing",
  "elliptical",
  "stairClimbing",
  "indoorSkiing",
  "indoorWalking",
  "indoorRunning",
  "virtualActivity",
]);

export function indoorFromFit(subSport: string): boolean {
  return FIT_INDOOR.has(subSport);
}
