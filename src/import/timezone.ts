import tzlookup from "tz-lookup";
import type { TrackPoint } from "./track";

export function trackTimezone(points: TrackPoint[]): string | null {
  const first = points[0];
  if (!first) {
    return null;
  }
  try {
    return tzlookup(first[0], first[1]);
  } catch {
    return null;
  }
}

export interface TimezoneSlot {
  startedAt: string;
  timezone: string | null;
}

// Activities without GPS (manual entries, trainer rides) carry no location.
// The export CSV has no timezone column either, so the best available guess
// is where the athlete was at the time: the zone of the nearest-in-time
// activity that has one. The fallback only applies when no activity in the
// input resolved a zone.
export function inferTimezones(
  slots: readonly TimezoneSlot[],
  fallback: string,
): string[] {
  const known = slots.flatMap((slot) =>
    slot.timezone === null
      ? []
      : [{ atMs: Date.parse(slot.startedAt), timezone: slot.timezone }],
  );

  return slots.map((slot) => {
    if (slot.timezone !== null) {
      return slot.timezone;
    }
    const atMs = Date.parse(slot.startedAt);
    let nearest: string | null = null;
    let nearestDelta = Infinity;
    for (const candidate of known) {
      const delta = Math.abs(candidate.atMs - atMs);
      if (delta < nearestDelta) {
        nearest = candidate.timezone;
        nearestDelta = delta;
      }
    }
    return nearest ?? fallback;
  });
}
