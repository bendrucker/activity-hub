// The publish stage: turn one activity into the row the website shows. The
// registry says when and what sport, the container reads the telemetry, and
// Strava's archived detail supplies the title and the numbers a device without
// sessions never recorded.

import {
  currentFingerprints,
  digest,
  inputFingerprint,
  MAX_ATTEMPTS,
  stageRows,
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
  publishPowerCurve(activityId: string, bests: readonly PowerBest[]): Promise<void>;
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

// Every fingerprint below is a SHA-256 digest, so neither sentinel can collide
// with one.
const DELETED = "deleted";
const UNDECODED = "undecoded";

function notDecoded(reason = "activity has not been decoded"): PublishResult {
  return { fingerprint: UNDECODED, status: "skipped", reason };
}

function stravaSource(sources: readonly ActivitySource[]): ActivitySource | undefined {
  return sources.find((source) => source.source === "strava");
}

function wahooSource(sources: readonly ActivitySource[]): ActivitySource | undefined {
  return sources.find((source) => source.source === "wahoo");
}

// Everything the publish stage reads out of D1 for one activity. The drain
// loads a whole queue batch of these in three queries, because the reads are
// identical per activity and the branching that consumes them is not.
export interface PublishContext {
  registry: ActivityRow | null;
  decode: StageRow | null;
  // The fingerprint publish last recorded as ok, absent when no current row
  // stands. Every "is this already published?" test is a comparison against
  // it, where each used to be its own query.
  published: string | undefined;
}

export async function publishContexts(
  db: D1Database,
  activityIds: readonly string[],
): Promise<Map<string, PublishContext>> {
  const [registries, decodes, published] = await Promise.all([
    activityRows(db, activityIds),
    stageRows(db, "decode", activityIds),
    currentFingerprints(db, "publish", activityIds),
  ]);

  return new Map(
    activityIds.map((activityId) => [
      activityId,
      {
        registry: registries.get(activityId) ?? null,
        decode: decodes.get(activityId) ?? null,
        published: published.get(activityId),
      },
    ]),
  );
}

export async function publishToSite(
  env: Env,
  activityId: string,
  context: PublishContext,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const site = options.site ?? sitePublisher(env);
  const { registry, decode, published } = context;
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
    if (published === DELETED) {
      return { fingerprint: DELETED, status: "current" };
    }
    await site.deleteActivity(activityId);
    return { fingerprint: DELETED, status: "ok" };
  }

  const hasOriginal = registry.sources.some((source) => source.rawKeys.original !== undefined);
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
    return publishWithoutTelemetry(env, activityId, registry, site, published);
  }

  // Resolved before the fingerprint because the keys are an input to the row,
    // not just a field on it.
  const photoKeys = await photos(env.RAW, registry.sources);
  const fingerprint = await publishFingerprint(env.RAW, registry, photoKeys, decode);
  if (published === fingerprint) {
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

  const detail = await stravaDetail(env.RAW, registry.sources);
  await site.publishActivity(row(activityId, registry, outcome.artifact, detail, photoKeys));
  await site.publishPowerCurve(activityId, outcome.artifact.bests);
  return { fingerprint, status: "ok" };
}

// Everything the published row is built from. Taking decode's fingerprint
// instead would only be right if decode's inputs were a superset of publish's,
// and they are not: the row also carries the archived photo keys, Strava's
// archived title and totals, and the registry's own sport, start and timezone.
// An activity that gains a photo moves none of decode's inputs, so publish
// reports it current and `touchDerivedAll` stamps it out of the staleness
// query with the site still holding no photo.
//
// This costs an R2 head per archived object and a list per photo prefix. The
// alternative to a check that can be trusted is no check, and that is a
// container `summarize` per activity per sweep.
//
// The registry fields are free, since the query that loaded the row already
// read them. They only reach here when a source's `updated_at` moved with
// them, which a re-ingest does: `activities.updated_at` alone is not what
// STALE compares.
async function publishFingerprint(
  bucket: R2Bucket,
  registry: ActivityRow,
  photoKeys: readonly string[],
  decode: StageRow | null,
  extraKeys: readonly string[] = [],
): Promise<string> {
  const detailKey = stravaSource(registry.sources)?.rawKeys.detail;
  const keys = [...photoKeys, ...extraKeys];
  if (detailKey !== undefined) {
    keys.push(detailKey);
  }

  return digest(
    [
      decode === null ? "" : `${decode.inputFingerprint}:${decode.artifactVersion}`,
      await inputFingerprint(bucket, keys),
      registry.name ?? "",
      registry.sport,
      registry.startedAt,
      registry.timezone,
      // Ordered by the registry query, so two sources hash the same way every
      // time.
      ...registry.sources.map((source) => `${source.source}/${source.sourceId}`),
    ].join("\n"),
  );
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
    decode.status === "skipped" || (decode.status === "failed" && decode.attempts >= MAX_ATTEMPTS)
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
  published: string | undefined,
): Promise<PublishResult> {
  const detailKey = stravaSource(registry.sources)?.rawKeys.detail;
  if (detailKey !== undefined) {
    return publishFromDetail(env, activityId, registry, site, published, detailKey);
  }

  const summaryKey = wahooSource(registry.sources)?.rawKeys.summary;
  if (summaryKey !== undefined) {
    return publishFromWahooSummary(env, activityId, registry, site, published, summaryKey);
  }

  return notDecoded("activity has no decoded telemetry and no provider record to publish from");
}

// Strava's detail carries totals but no telemetry, so the row publishes with
// no power and no map. The fingerprint covers the same archive the row is
// built from, minus the decode artifact there is no row for.
async function publishFromDetail(
  env: Env,
  activityId: string,
  registry: ActivityRow,
  site: SitePublisher,
  published: string | undefined,
  detailKey: string,
): Promise<PublishResult> {
  const photoKeys = await photos(env.RAW, registry.sources);
  const fingerprint = await publishFingerprint(env.RAW, registry, photoKeys, null);
  if (published === fingerprint) {
    return { fingerprint, status: "current" };
  }

  const detail = await stravaDetail(env.RAW, registry.sources);
  // `publishFingerprint` just read this key's etag, so a miss here is the
  // bucket misbehaving. Recording it as failed keeps the row in the staleness
  // query, which retries it.
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
// The `durationS` helper beside this reads `duration_total_accum`, which is
// elapsed time including pauses: it reads 61,419 on a workout left running
// overnight and disagrees with `movingS` by design. Using it here would
// publish 47 of these as day-long rides.
async function publishFromWahooSummary(
  env: Env,
  activityId: string,
  registry: ActivityRow,
  site: SitePublisher,
  published: string | undefined,
  summaryKey: string,
): Promise<PublishResult> {
  const photoKeys = await photos(env.RAW, registry.sources);
  const fingerprint = await publishFingerprint(env.RAW, registry, photoKeys, null, [summaryKey]);
  if (published === fingerprint) {
    return { fingerprint, status: "current" };
  }

  // The fingerprint's etag lookup already found this key, so a miss here is
  // the bucket misbehaving. Only a failed row gets retried.
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
    photoKeys,
  });
  return { fingerprint, status: "ok" };
}

interface ActivitySource {
  source: string;
  sourceId: string;
  rawKeys: Record<string, string>;
}

export interface ActivityRow {
  name: string | null;
  sport: string;
  startedAt: string;
  timezone: string;
  sources: ActivitySource[];
}

// Strava's archived detail is the live title and wins wherever it exists. The
// registry's name comes from the bulk export, which is a snapshot, so it
// stands in for the activities whose detail was never archived.
function title(registry: ActivityRow, detail: StravaDetail | null): string | null {
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

async function activityRows(
  db: D1Database,
  activityIds: readonly string[],
): Promise<Map<string, ActivityRow>> {
  if (activityIds.length === 0) {
    return new Map();
  }

  const placeholders = activityIds.map((_, index) => `?${index + 1}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT activities.activity_id, activities.name, activities.sport,
              activities.started_at, activities.timezone,
              sources.source, sources.source_id, sources.raw_keys
       FROM activities
       LEFT JOIN activity_sources AS sources
         ON sources.activity_id = activities.activity_id
        AND sources.deleted_at IS NULL
       WHERE activities.activity_id IN (${placeholders})
       ORDER BY activities.activity_id, sources.source, sources.source_id`,
    )
    .bind(...activityIds)
    .all<{
      activity_id: string;
      name: string | null;
      sport: string;
      started_at: string;
      timezone: string;
      source: string | null;
      source_id: string | null;
      raw_keys: string | null;
    }>();

  const rows = new Map<string, ActivityRow>();
  for (const result of results) {
    let activity = rows.get(result.activity_id);
    if (activity === undefined) {
      activity = {
        name: result.name,
        sport: result.sport,
        startedAt: result.started_at,
        timezone: result.timezone,
        sources: [],
      };
      rows.set(result.activity_id, activity);
    }
    // The LEFT JOIN emits one null-source row for an activity whose sources
    // are all deleted, which is the shape that drives the delete-from-site
    // path below. The activity still has to appear in the map to get there.
    if (result.source !== null && result.source_id !== null) {
      activity.sources.push({
        source: result.source,
        sourceId: result.source_id,
        rawKeys: rawKeys(result.raw_keys),
      });
    }
  }
  return rows;
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
async function photos(bucket: R2Bucket, sources: readonly ActivitySource[]): Promise<string[]> {
  const keys = new Set<string>();
  const prefixes: string[] = [];
  for (const source of sources) {
    for (const [name, key] of Object.entries(source.rawKeys)) {
      if (name === "photos") {
        prefixes.push(key);
      } else if (name.startsWith("photos/")) {
        keys.add(key);
      }
    }
  }

  // One prefix per source, each independent of the others. Collecting them
  // first is what lets the listings go out together, and the Set still dedupes
  // whatever two overlapping prefixes both return.
  for (const listed of await Promise.all(prefixes.map((prefix) => listPrefix(bucket, prefix)))) {
    for (const key of listed) {
      keys.add(key);
    }
  }
  return [...keys].toSorted();
}

async function listPrefix(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    // Cursor pagination: the next cursor and the truncation flag both come
    // off the previous response.
    // oxlint-disable-next-line no-await-in-loop
    const listed = await bucket.list({ prefix, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}
