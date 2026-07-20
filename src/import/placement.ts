import type { SourceRecord } from "../record";
import { sportFromStrava } from "../sport";
import type { ExportActivity } from "./csv";

export const RAW_PREFIX = "raw/strava/activities";
export const DERIVED_PREFIX = "derived/strava/activities";

export interface ObjectPlacement {
  key: string;
  sourcePath: string;
}

export interface Placement {
  objects: ObjectPlacement[];
  rawKeys: Record<string, string>;
  polylineKey: string;
}

// The export names files by upload ID, so the original keeps only its
// extension chain (.fit.gz stays gzipped: the raw layer stores the export's
// bytes untouched).
export function placeActivity(
  activity: ExportActivity,
  mediaAvailable: ReadonlySet<string>,
): Placement {
  const objects: ObjectPlacement[] = [];
  const rawKeys: Record<string, string> = {};

  if (activity.filename) {
    const base = basename(activity.filename);
    const dot = base.indexOf(".");
    const extension = dot === -1 ? "" : base.slice(dot);
    const key = `${RAW_PREFIX}/${activity.sourceId}/original${extension}`;
    objects.push({ key, sourcePath: activity.filename });
    rawKeys["original"] = key;
  }

  for (const media of activity.media) {
    if (!mediaAvailable.has(media)) {
      continue;
    }
    const name = basename(media);
    const key = `${RAW_PREFIX}/${activity.sourceId}/photos/${name}`;
    objects.push({ key, sourcePath: media });
    rawKeys[`photos/${name}`] = key;
  }

  return {
    objects,
    rawKeys,
    polylineKey: `${DERIVED_PREFIX}/${activity.sourceId}/polyline.json`,
  };
}

export function toSourceRecord(
  activity: ExportActivity,
  timezone: string,
  rawKeys: Record<string, string>,
): SourceRecord {
  return {
    source: "strava",
    sourceId: activity.sourceId,
    startedAt: activity.startedAt,
    timezone,
    sport: sportFromStrava(activity.sportType),
    durationS: activity.elapsedS,
    rawKeys,
  };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
