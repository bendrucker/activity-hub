// The publish stage: turn one activity into the row the website shows. The
// registry says when and what sport, the container reads the telemetry, and
// Strava's archived detail supplies the title and the numbers a device without
// sessions never recorded.

import {
  inputFingerprint,
  isCurrent,
  MAX_ATTEMPTS,
  stageRow,
  type StageRow,
} from "../derived";
import { lakeUri } from "../lake/location";
import { isWorkoutSummary } from "../wahoo/summary";
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

function notDecoded(reason = "activity has not been decoded"): PublishResult {
  return { fingerprint: UNDECODED, status: "skipped", reason };
}

function stravaSource(
  sources: readonly ActivitySource[],
): ActivitySource | undefined {
  return sources.find((source) => source.source === "strava");
}

function wahooSource(
  sources: readonly ActivitySource[],
): ActivitySource | undefined {
  return sources.find((source) => source.source === "wahoo");
}

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

  const hasOriginal = registry.sources.some(
    (source) => source.rawKeys.original !== undefined,
  );
  const decode = await stageRow(env.REGISTRY, activityId, "decode");
  if (decode?.status !== "ok" || decode.outputKey === null) {
    if (!decodeSettled(decode, hasOriginal)) {
      return notDecoded();
    }
    if (hasOriginal) {
      // An archived file decode read and gave up on. The row that follows
      // carries no telemetry, so an activity that once published a full one is
      // quietly downgraded, and nothing else in the pipeline reports that.
      console.warn(
        `publishing ${activityId} without telemetry: decode ${decode?.status ?? "never ran"}`,
      );
    }
    return publishWithoutTelemetry(env, activityId, registry, site);
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

// Whether decode has said everything it is going to say. No archived original
// means it will never run at all. A `skipped` row means it ran and found nothing
// among the raw keys it could read. A `failed` row at the attempt ceiling is
// invisible to the staleness query, so nothing will ever run it again either.
// In each case no Parquet is coming, and waiting for one strands the activity.
function decodeSettled(decode: StageRow | null, hasOriginal: boolean): boolean {
  if (!hasOriginal) {
    return true;
  }
  if (decode === null) {
    return false;
  }
  return (
    decode.status === "skipped" ||
    (decode.status === "failed" && decode.attempts >= MAX_ATTEMPTS)
  );
}

// With no telemetry to summarize, the row carries whatever the provider
// archived beside the file. Strava's detail holds the totals, and a Wahoo
// workout old enough that the cloud kept no file has only its summary.
async function publishWithoutTelemetry(
  env: Env,
  activityId: string,
  registry: ActivityRow,
  site: SitePublisher,
): Promise<PublishResult> {
  const detailKey = stravaSource(registry.sources)?.rawKeys.detail;
  if (detailKey !== undefined) {
    return publishFromDetail(env, activityId, registry, site, detailKey);
  }

  const summaryKey = wahooSource(registry.sources)?.rawKeys.summary;
  if (summaryKey !== undefined) {
    return publishFromWahooSummary(env, activityId, registry, site, summaryKey);
  }

  return notDecoded(
    "activity has no decoded telemetry and no provider record to publish from",
  );
}

// Strava's detail carries totals but no telemetry, so the row publishes with
// no power and no map. The fingerprint is the detail file's etag, since there
// is no decode row to take one from.
async function publishFromDetail(
  env: Env,
  activityId: string,
  registry: ActivityRow,
  site: SitePublisher,
  detailKey: string,
): Promise<PublishResult> {
  const fingerprint = await inputFingerprint(env.RAW, [detailKey]);
  if (await isCurrent(env.REGISTRY, activityId, "publish", fingerprint)) {
    return { fingerprint, status: "current" };
  }

  const [detail, photoKeys] = await Promise.all([
    stravaDetail(env.RAW, registry.sources),
    photos(env.RAW, registry.sources),
  ]);
  // `inputFingerprint` just read this key's etag, so a miss here is the bucket
  // misbehaving rather than an activity with nothing to publish. Recording it
  // as failed keeps the row in the staleness query, which retries it. A skip
  // would leave the row settled and unreachable forever.
  if (detail === null) {
    return {
      fingerprint,
      status: "failed",
      error: `archived Strava detail ${detailKey} could not be read`,
    };
  }

  await site.publishActivity({
    activityId,
    stravaId: stravaSource(registry.sources)?.sourceId ?? null,
    name: title(registry, detail),
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

// A Wahoo summary is start time, sport, and recorded minutes. It has no
// distance, elevation, or power, so those publish null and the site shows that
// the ride happened without claiming anything about it.
//
// Minutes at zero is the signature of an aborted or never-stopped recording:
// the head unit accumulated elapsed time while capturing nothing. Those stay
// off the site. The registry keeps them because the workout is real even where
// the ride is not.
//
// `minutes` rather than the `durationS` helper beside it, which prefers
// `duration_total_accum`. That field is elapsed time including pauses, so it
// reads 61,419 on a workout left running overnight and disagrees with `movingS`
// by design. Swapping it in here would publish 47 of these as day-long rides.
async function publishFromWahooSummary(
  env: Env,
  activityId: string,
  registry: ActivityRow,
  site: SitePublisher,
  summaryKey: string,
): Promise<PublishResult> {
  const fingerprint = await inputFingerprint(env.RAW, [summaryKey]);
  if (await isCurrent(env.REGISTRY, activityId, "publish", fingerprint)) {
    return { fingerprint, status: "current" };
  }

  // Failed rather than skipped for the same reason as the detail read above:
  // the fingerprint's etag lookup already found this key, so a miss is the
  // bucket misbehaving, and only a failed row gets retried.
  const object = await env.RAW.get(summaryKey);
  if (object === null) {
    return {
      fingerprint,
      status: "failed",
      error: `archived Wahoo summary ${summaryKey} is missing`,
    };
  }
  const parsed: unknown = await object.json();
  if (!isWorkoutSummary(parsed)) {
    return {
      fingerprint,
      status: "failed",
      error: `archived Wahoo summary ${summaryKey} is unreadable`,
    };
  }

  const { minutes } = parsed.workout;
  if (minutes <= 0) {
    return {
      fingerprint,
      status: "skipped",
      reason: "Wahoo recorded no minutes for this workout",
    };
  }

  await site.publishActivity({
    activityId,
    stravaId: null,
    name: registry.name,
    sport: registry.sport,
    startedAt: registry.startedAt,
    timezone: registry.timezone,
    distanceM: null,
    movingS: minutes * 60,
    elevationM: null,
    averageWatts: null,
    powerSource: "none",
    polyline: null,
    elevationProfile: null,
    photoKeys: await photos(env.RAW, registry.sources),
  });
  return { fingerprint, status: "ok" };
}

interface ActivitySource {
  source: string;
  sourceId: string;
  rawKeys: Record<string, string>;
}

interface ActivityRow {
  name: string | null;
  sport: string;
  startedAt: string;
  timezone: string;
  sources: ActivitySource[];
}

// Strava's archived detail is the live title and wins wherever it exists. The
// registry's name comes from the bulk export, which is a snapshot, so it
// stands in for the activities whose detail was never archived.
function title(
  registry: ActivityRow,
  detail: StravaDetail | null,
): string | null {
  return detail?.name ?? registry.name;
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
    stravaId: stravaSource(registry.sources)?.sourceId ?? null,
    name: title(registry, detail),
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
      `SELECT activities.name, activities.sport, activities.started_at,
              activities.timezone,
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
      name: string | null;
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
    name: first.name,
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
  const key = stravaSource(sources)?.rawKeys.detail;
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
