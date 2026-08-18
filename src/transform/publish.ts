// The publish stage: turn one activity into the row the website shows. The
// registry says when and what sport, the container reads the telemetry, and
// Strava's archived detail supplies the title and the numbers a device without
// sessions never recorded.

import {
  activityRawKeys,
  inputFingerprint,
  isCurrent,
  stageArtifact,
} from "../derived";
import { lakeUri } from "../lake/location";
import { publishClient, type PublishClient } from "./container";
import type { PowerBest, PowerSource, PublishArtifact } from "./protocol";

// Hand-written on both sides. The site's Publish entrypoint lives in another
// repo, so nothing generates this from its class, and a field that drifts
// comes back as a ValidationError from the callee rather than a type error
// here.
export interface PublishedActivity {
  activityId: string;
  stravaId: string | null;
  name: string | null;
  sport: string;
  startedAt: string;
  timezone: string;
  distanceM: number | null;
  movingS: number | null;
  elevationM: number | null;
  averageWatts: number | null;
  powerSource: PowerSource;
  polyline: string | null;
  elevationProfile: number[] | null;
  photoKeys: string[];
}

export interface SitePublisher {
  publishActivity(row: PublishedActivity): Promise<void>;
  publishPowerCurve(
    activityId: string,
    bests: readonly PowerBest[],
  ): Promise<void>;
  deleteActivity(activityId: string): Promise<void>;
}

// The binding is a Service that also carries Publish's methods, which is what
// makes reading them off it a narrowing rather than a leap. Nothing generates
// the method list from the other repo, so this is where the two agree.
type SiteBinding = Service & SitePublisher;

export function sitePublisher(env: Env): SitePublisher {
  return env.SITE as SiteBinding;
}

export interface PublishOptions {
  container?: PublishClient;
  site?: SitePublisher;
}

export type PublishResult = { fingerprint: string } & (
  | { status: "current" }
  | { status: "ok" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
);

// Publish reads the decode artifact, so its fingerprint is the decode row's.
// Raw bytes that changed already changed that fingerprint, and a decoder that
// changed already changed the version. Neither sentinel can collide with a
// SHA-256 digest.
const DELETED = "deleted";
const UNDECODED = "undecoded";

export async function publishToSite(
  env: Env,
  activityId: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const site = options.site ?? sitePublisher(env);
  const registry = await activityRow(env.REGISTRY, activityId);
  if (registry === null) {
    return {
      fingerprint: UNDECODED,
      status: "skipped",
      reason: "activity is not in the registry",
    };
  }

  // Every source gone is the only signal a deletion leaves: the activity drops
  // out of the staleness query at the same moment, so this message is the last
  // chance to take the row off the site.
  if (registry.sources.length === 0) {
    if (await isCurrent(env.REGISTRY, activityId, "publish", DELETED)) {
      return { fingerprint: DELETED, status: "current" };
    }
    await site.deleteActivity(activityId);
    return { fingerprint: DELETED, status: "ok" };
  }

  const decode = await stageArtifact(env.REGISTRY, activityId, "decode");
  if (decode === null || decode.outputKey === null) {
    // No archived original means decode will never run, so this is the only
    // route this activity can reach the site by. Strava's detail carries
    // totals but no telemetry, so the row publishes with no power or map.
    const rawKeys = await activityRawKeys(env.REGISTRY, activityId);
    if (rawKeys.length === 0) {
      return publishFromDetailOnly(env, activityId, registry, site);
    }
    return {
      fingerprint: UNDECODED,
      status: "skipped",
      reason: "activity has not been decoded",
    };
  }

  const fingerprint = `${decode.inputFingerprint}:${decode.artifactVersion}`;
  if (await isCurrent(env.REGISTRY, activityId, "publish", fingerprint)) {
    return { fingerprint, status: "current" };
  }

  const client = options.container ?? publishClient(env);
  const { outcome } = await client.summarize({
    work: { activityId, decode: lakeUri(decode.outputKey) },
  });
  if (outcome.status === "failed") {
    return { fingerprint, status: "failed", error: outcome.error };
  }
  if (outcome.status === "skipped") {
    return { fingerprint, status: "skipped", reason: outcome.reason };
  }

  const [detail, photoKeys] = await Promise.all([
    stravaDetail(env.RAW, registry.sources),
    photos(env.RAW, registry.sources),
  ]);
  await site.publishActivity(
    row(activityId, registry, outcome.artifact, detail, photoKeys),
  );
  await site.publishPowerCurve(activityId, outcome.artifact.bests);
  return { fingerprint, status: "ok" };
}

// The only telemetry-free path to the site: a Strava import that never got an
// archived original, so decode permanently skips it and there is no Parquet
// to summarize. Strava's own totals are the whole row, and the fingerprint is
// the detail file's etag rather than a decode row's, since there is none.
async function publishFromDetailOnly(
  env: Env,
  activityId: string,
  registry: ActivityRow,
  site: SitePublisher,
): Promise<PublishResult> {
  const detailKey = registry.sources.find(
    (source) => source.source === "strava",
  )?.rawKeys.detail;
  if (detailKey === undefined) {
    return {
      fingerprint: UNDECODED,
      status: "skipped",
      reason: "activity has not been decoded",
    };
  }

  const fingerprint = await inputFingerprint(env.RAW, [detailKey]);
  if (await isCurrent(env.REGISTRY, activityId, "publish", fingerprint)) {
    return { fingerprint, status: "current" };
  }

  const [detail, photoKeys] = await Promise.all([
    stravaDetail(env.RAW, registry.sources),
    photos(env.RAW, registry.sources),
  ]);
  if (detail === null) {
    return {
      fingerprint: UNDECODED,
      status: "skipped",
      reason: "activity has not been decoded",
    };
  }

  await site.publishActivity({
    activityId,
    stravaId:
      registry.sources.find((source) => source.source === "strava")?.sourceId ??
      null,
    name: detail.name,
    sport: registry.sport,
    startedAt: registry.startedAt,
    timezone: registry.timezone,
    distanceM: detail.distance,
    movingS: detail.movingTime,
    elevationM: detail.elevationGain,
    averageWatts: null,
    powerSource: "none",
    polyline: null,
    elevationProfile: null,
    photoKeys,
  });
  return { fingerprint, status: "ok" };
}

interface ActivitySource {
  source: string;
  sourceId: string;
  rawKeys: Record<string, string>;
}

interface ActivityRow {
  sport: string;
  startedAt: string;
  timezone: string;
  sources: ActivitySource[];
}

// The device's own totals win where it recorded them, matching how the lake's
// activities table resolves the same disagreement. Strava's numbers stand in
// for a file that carries records but no session summary.
function row(
  activityId: string,
  registry: ActivityRow,
  artifact: PublishArtifact,
  detail: StravaDetail | null,
  photoKeys: string[],
): PublishedActivity {
  return {
    activityId,
    stravaId:
      registry.sources.find((source) => source.source === "strava")?.sourceId ??
      null,
    name: detail?.name ?? null,
    sport: registry.sport,
    startedAt: registry.startedAt,
    timezone: registry.timezone,
    distanceM: artifact.distanceM ?? detail?.distance ?? null,
    movingS: artifact.movingS ?? detail?.movingTime ?? null,
    elevationM: artifact.elevationM ?? detail?.elevationGain ?? null,
    averageWatts: artifact.averageWatts,
    powerSource: artifact.powerSource,
    polyline: artifact.polyline,
    elevationProfile: artifact.elevationProfile,
    photoKeys,
  };
}

async function activityRow(
  db: D1Database,
  activityId: string,
): Promise<ActivityRow | null> {
  const { results } = await db
    .prepare(
      `SELECT activities.sport, activities.started_at, activities.timezone,
              sources.source, sources.source_id, sources.raw_keys
       FROM activities
       LEFT JOIN activity_sources AS sources
         ON sources.activity_id = activities.activity_id
        AND sources.deleted_at IS NULL
       WHERE activities.activity_id = ?1
       ORDER BY sources.source, sources.source_id`,
    )
    .bind(activityId)
    .all<{
      sport: string;
      started_at: string;
      timezone: string;
      source: string | null;
      source_id: string | null;
      raw_keys: string | null;
    }>();

  const [first] = results;
  if (first === undefined) {
    return null;
  }
  return {
    sport: first.sport,
    startedAt: first.started_at,
    timezone: first.timezone,
    sources: results.flatMap((result) =>
      result.source === null || result.source_id === null
        ? []
        : [
            {
              source: result.source,
              sourceId: result.source_id,
              rawKeys: rawKeys(result.raw_keys),
            },
          ],
    ),
  };
}

function rawKeys(value: string | null): Record<string, string> {
  if (value === null) {
    return {};
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const keys: Record<string, string> = {};
  for (const [name, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === "string") {
      keys[name] = key;
    }
  }
  return keys;
}

interface StravaDetail {
  name: string | null;
  distance: number | null;
  movingTime: number | null;
  elevationGain: number | null;
}

async function stravaDetail(
  bucket: R2Bucket,
  sources: readonly ActivitySource[],
): Promise<StravaDetail | null> {
  const key = sources.find((source) => source.source === "strava")?.rawKeys
    .detail;
  if (key === undefined) {
    return null;
  }

  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }

  const parsed: unknown = await object.json();
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const detail = parsed as Record<string, unknown>;
  return {
    name: typeof detail.name === "string" ? detail.name : null,
    distance: number(detail.distance),
    movingTime: number(detail.moving_time),
    elevationGain: number(detail.total_elevation_gain),
  };
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Two shapes reach raw_keys: the webhook path records one `photos` entry
// holding a prefix, and the import path records a `photos/<name>` entry per
// file. Only the prefix costs a list.
async function photos(
  bucket: R2Bucket,
  sources: readonly ActivitySource[],
): Promise<string[]> {
  const keys = new Set<string>();
  for (const source of sources) {
    for (const [name, key] of Object.entries(source.rawKeys)) {
      if (name === "photos") {
        for (const listed of await listPrefix(bucket, key)) {
          keys.add(listed);
        }
      } else if (name.startsWith("photos/")) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

async function listPrefix(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}
