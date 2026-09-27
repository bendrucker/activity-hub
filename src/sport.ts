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
// BIKING family. FE_BIKE and FE_TREADMILL are fitness equipment the head unit
// paired with, so they are indoor even though their names do not say so.
const WAHOO_TYPES: Record<number, { sport: Sport; indoor?: true }> = {
  0: { sport: "ride" }, // BIKING
  11: { sport: "ride" }, // BIKING_CYCLECROSS
  12: { sport: "ride", indoor: true }, // BIKING_INDOOR
  13: { sport: "ride" }, // BIKING_MOUNTAIN
  14: { sport: "ride" }, // BIKING_RECUMBENT
  15: { sport: "ride" }, // BIKING_ROAD
  16: { sport: "ride" }, // BIKING_TRACK
  21: { sport: "ride", indoor: true }, // FE_BIKE
  49: { sport: "ride", indoor: true }, // BIKING_INDOOR_CYCLING_CLASS
  61: { sport: "ride", indoor: true }, // BIKING_INDOOR_TRAINER
  64: { sport: "ride" }, // EBIKING
  68: { sport: "ride", indoor: true }, // BIKING_INDOOR_VIRTUAL
  70: { sport: "ride" }, // HANDCYCLING
  1: { sport: "run" }, // RUNNING
  3: { sport: "run" }, // RUNNING_TRACK
  4: { sport: "run" }, // RUNNING_TRAIL
  5: { sport: "run", indoor: true }, // RUNNING_TREADMILL
  19: { sport: "run", indoor: true }, // FE_TREADMILL
  67: { sport: "run" }, // RUNNING_RACE
  71: { sport: "run", indoor: true }, // RUNNING_INDOOR_VIRTUAL
  6: { sport: "walk" }, // WALKING
  7: { sport: "walk" }, // WALKING_SPEED
  8: { sport: "walk" }, // WALKING_NORDIC
  56: { sport: "walk", indoor: true }, // WALKING_TREADMILL
  9: { sport: "hike" }, // HIKING
  10: { sport: "hike" }, // MOUNTAINEERING
  25: { sport: "swim" }, // SWIMMING_LAP
  26: { sport: "swim" }, // SWIMMING_OPEN_WATER
  42: { sport: "strength" }, // WORKOUT
};

export function sportFromWahoo(workoutTypeId: number): Sport {
  return WAHOO_TYPES[workoutTypeId]?.sport ?? "other";
}

// Whether a source's own type says the activity happened indoors. The site
// leaves these out of every record, because a trainer's distance is a wheel
// sensor's guess and a virtual course's climbing happened in a game.
const STRAVA_INDOOR = new Set(["VirtualRide", "VirtualRun", "VirtualRow"]);

// Strava's `trainer` flag marks a ride on a trainer that the athlete left
// typed as a plain Ride, which the sport type alone cannot tell apart. Without
// the flag, as in the bulk export, a plain Ride is unknown rather than outdoor.
export function indoorFromStrava(sportType: string, trainer?: boolean): boolean | null {
  if (STRAVA_INDOOR.has(sportType) || trainer === true) {
    return true;
  }
  return trainer === undefined ? null : false;
}

export function indoorFromWahoo(workoutTypeId: number): boolean {
  return WAHOO_TYPES[workoutTypeId]?.indoor === true;
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
