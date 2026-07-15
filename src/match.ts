import type { Sport } from "./sport";

export const MAX_START_DELTA_S = 120;
export const MAX_DURATION_RATIO = 0.05;

export interface MatchInput {
  startedAt: string;
  sport: Sport;
  durationS: number;
}

export interface MatchCandidate extends MatchInput {
  activityId: string;
}

export function matchActivity(
  candidate: MatchInput,
  existing: readonly MatchCandidate[],
): MatchCandidate | null {
  const candidateStart = Date.parse(candidate.startedAt);

  let best: MatchCandidate | null = null;
  let bestDeltaS = Infinity;

  for (const activity of existing) {
    if (activity.sport !== candidate.sport) {
      continue;
    }

    const deltaS =
      Math.abs(Date.parse(activity.startedAt) - candidateStart) / 1000;
    if (deltaS > MAX_START_DELTA_S) {
      continue;
    }

    const longest = Math.max(candidate.durationS, activity.durationS);
    const ratio =
      longest === 0
        ? 0
        : Math.abs(candidate.durationS - activity.durationS) / longest;
    if (ratio > MAX_DURATION_RATIO) {
      continue;
    }

    if (deltaS < bestDeltaS) {
      best = activity;
      bestDeltaS = deltaS;
    }
  }

  return best;
}
