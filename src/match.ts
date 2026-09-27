import type { Sport } from "./sport";

// Wahoo starts the clock when the head unit starts recording, Strava at its
// first sample or at a start the athlete cropped to, so the same ride can
// start minutes apart between the two. The widest gap in the registry is
// 710 s, so a pair further apart than this mints two activities.
export const MAX_START_DELTA_S = 900;

// The same ride recorded twice nests one recording inside the other. A Wahoo
// unit left running after a short ride can still overlap the start of the
// next one, but only by a sliver of the shorter recording.
export const MIN_OVERLAP_RATIO = 0.8;

export interface MatchInput {
  startedAt: string;
  sport: Sport;
  durationS: number;
}

export interface MatchCandidate extends MatchInput {
  activityId: string;
}

// Two records are one ride when they share a sport and the shorter recording
// falls mostly inside the longer. Durations cannot be compared directly: Wahoo
// counts paused time up to the stop button, and Strava reports the elapsed
// time after any crop, so the same ride can differ by hours. A zero-duration
// recording never matches, which keeps the device's empty duplicate workouts
// from claiming a ride.
export function matchActivity(
  candidate: MatchInput,
  existing: readonly MatchCandidate[],
): MatchCandidate | null {
  const candidateStart = Date.parse(candidate.startedAt) / 1000;

  let best: MatchCandidate | null = null;
  let bestRank: [number, number] = [Infinity, Infinity];

  for (const activity of existing) {
    if (activity.sport !== candidate.sport) {
      continue;
    }

    const activityStart = Date.parse(activity.startedAt) / 1000;
    const deltaS = Math.abs(activityStart - candidateStart);
    if (deltaS > MAX_START_DELTA_S) {
      continue;
    }

    const overlapStart = Math.max(candidateStart, activityStart);
    const overlapEnd = Math.min(
      candidateStart + candidate.durationS,
      activityStart + activity.durationS,
    );
    const shorter = Math.min(candidate.durationS, activity.durationS);
    if (shorter === 0 || overlapEnd - overlapStart < MIN_OVERLAP_RATIO * shorter) {
      continue;
    }

    const durationGap = Math.abs(candidate.durationS - activity.durationS);
    if (deltaS < bestRank[0] || (deltaS === bestRank[0] && durationGap < bestRank[1])) {
      best = activity;
      bestRank = [deltaS, durationGap];
    }
  }

  return best;
}
