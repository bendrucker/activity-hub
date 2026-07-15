export type Sport =
  "ride" | "run" | "walk" | "hike" | "swim" | "strength" | "other";

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
