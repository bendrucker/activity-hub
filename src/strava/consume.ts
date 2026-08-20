import {
  RateLimitedError,
  type StravaIngestMessage,
  retryAfterS,
} from "../ingest";
import {
  markSourceDeleted,
  mergeRawKeys,
  upsertSourceRecord,
} from "../registry";
import { sportFromStrava } from "../sport";
import { enqueueActivity } from "../transform/enqueue";
import { stravaClient, type StravaClient } from "./client";

export interface ConsumeOptions {
  client?: StravaClient;
  // For downloading photo CDN URLs, which bypass the StravaClient.
  fetch?: typeof globalThis.fetch;
}

interface StravaActivityDetail {
  id: number;
  start_date: string;
  timezone: string;
  sport_type: string;
  elapsed_time: number;
}

interface StravaPhoto {
  unique_id: string;
  urls: Record<string, string>;
}

function detailKey(activityId: number): string {
  return `raw/strava/activities/${activityId}/detail.json`;
}

function streamsKey(activityId: number): string {
  return `raw/strava/activities/${activityId}/streams.json`;
}

function photosPrefix(activityId: number): string {
  return `raw/strava/activities/${activityId}/photos/`;
}

async function fetchOrThrow(
  client: StravaClient,
  path: string,
): Promise<Response> {
  const response = await client.fetch(path);
  if (response.status === 429) {
    throw new RateLimitedError(
      `rate limited on ${path}`,
      retryAfterS(response),
    );
  }
  return response;
}

// Strava formats timezone as "(GMT-08:00) America/Los_Angeles". The IANA
// name is what everything downstream expects.
function parseTimezone(raw: string): string {
  const marker = ") ";
  const index = raw.indexOf(marker);
  return index === -1 ? raw : raw.slice(index + marker.length);
}

// The body comes back as text so a refresh can compare it byte for byte
// against what R2 already holds.
async function fetchDetailText(
  client: StravaClient,
  activityId: number,
): Promise<string | null> {
  const response = await fetchOrThrow(client, `/activities/${activityId}`);
  if (response.status === 404) {
    console.warn(`Strava activity ${activityId} not found, skipping`);
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Strava activity ${activityId} fetch failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.text();
}

async function fetchStreams(
  client: StravaClient,
  env: Env,
  activityId: number,
): Promise<boolean> {
  const response = await fetchOrThrow(
    client,
    `/activities/${activityId}/streams?keys=time,distance,latlng,altitude,heartrate,cadence,watts,temp,moving,grade_smooth&key_by_type=true`,
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `Strava streams ${activityId} fetch failed: ${response.status} ${await response.text()}`,
    );
  }
  await env.RAW.put(streamsKey(activityId), await response.text());
  return true;
}

function largestPhotoUrl(photo: StravaPhoto): string | undefined {
  return photo.urls["5000"] ?? Object.values(photo.urls)[0];
}

interface PhotoSync {
  stored: number;
  added: number;
}

async function storedPhotoIds(
  env: Env,
  activityId: number,
): Promise<Set<string>> {
  const prefix = photosPrefix(activityId);
  const listing = await env.RAW.list({ prefix });
  return new Set(
    listing.objects.map((object) =>
      object.key.slice(prefix.length).replace(/\.jpg$/, ""),
    ),
  );
}

async function downloadPhoto(
  env: Env,
  activityId: number,
  photo: StravaPhoto,
  fetch: typeof globalThis.fetch,
): Promise<boolean> {
  const url = largestPhotoUrl(photo);
  if (!url) {
    return false;
  }
  try {
    const download = await fetch(url);
    if (!download.ok) {
      console.warn(
        `Strava photo ${activityId}/${photo.unique_id} download failed: ${download.status}`,
      );
      return false;
    }
    await env.RAW.put(
      `${photosPrefix(activityId)}${photo.unique_id}.jpg`,
      await download.arrayBuffer(),
    );
    return true;
  } catch (error) {
    console.warn(
      `Strava photo ${activityId}/${photo.unique_id} download errored: ${String(error)}`,
    );
    return false;
  }
}

// Undocumented endpoint, so any failure (bad response, bad JSON, download
// error) is failure-tolerant: warn and move on rather than fail the event.
// Photo bytes are immutable under their unique id, so anything already in R2
// is skipped and the listing is only a source of ids to add.
async function syncPhotos(
  client: StravaClient,
  env: Env,
  activityId: number,
  fetch: typeof globalThis.fetch,
): Promise<PhotoSync> {
  const stored = await storedPhotoIds(env, activityId);
  const response = await fetchOrThrow(
    client,
    `/activities/${activityId}/photos?size=5000&photo_sources=true`,
  );
  if (!response.ok) {
    console.warn(
      `Strava photos ${activityId} fetch failed: ${response.status}`,
    );
    return { stored: stored.size, added: 0 };
  }

  let photos: StravaPhoto[];
  try {
    photos = (await response.json()) as StravaPhoto[];
  } catch {
    console.warn(`Strava photos ${activityId} returned invalid JSON`);
    return { stored: stored.size, added: 0 };
  }

  // CDN downloads don't count against the API read budget, so they can
  // overlap freely.
  const wrote = await Promise.all(
    photos
      .filter((photo) => !stored.has(photo.unique_id))
      .map((photo) => downloadPhoto(env, activityId, photo, fetch)),
  );
  return { stored: stored.size, added: wrote.filter(Boolean).length };
}

async function upsertDetail(
  env: Env,
  activityId: number,
  detail: StravaActivityDetail,
  rawKeys: Record<string, string>,
): Promise<void> {
  await upsertSourceRecord(env.REGISTRY, {
    source: "strava",
    sourceId: String(activityId),
    startedAt: detail.start_date,
    // Strava reports the zone itself, so it is never inferred here.
    timezone: parseTimezone(detail.timezone),
    timezoneInferred: false,
    sport: sportFromStrava(detail.sport_type),
    durationS: detail.elapsed_time,
    rawKeys,
  });
}

// Nothing about an activity is fetched twice unless it can have changed: the
// detail body is compared against R2 before it is rewritten, streams are
// immutable once recorded, and photos are diffed by id.
async function refreshActivity(
  activityId: number,
  env: Env,
  options: ConsumeOptions,
): Promise<string | undefined> {
  const client = options.client ?? stravaClient(env);
  const text = await fetchDetailText(client, activityId);
  if (text === null) {
    return "skipped: activity not found";
  }

  const stored = await env.RAW.get(detailKey(activityId));
  const detailChanged = (await stored?.text()) !== text;
  if (detailChanged) {
    await env.RAW.put(detailKey(activityId), text);
  }

  const rawKeys: Record<string, string> = { detail: detailKey(activityId) };

  const hadStreams = (await env.RAW.head(streamsKey(activityId))) !== null;
  const streamsAdded =
    !hadStreams && (await fetchStreams(client, env, activityId));
  if (hadStreams || streamsAdded) {
    rawKeys.streams = streamsKey(activityId);
  }

  const photos = await syncPhotos(
    client,
    env,
    activityId,
    options.fetch ?? globalThis.fetch,
  );
  if (photos.stored + photos.added > 0) {
    rawKeys.photos = photosPrefix(activityId);
  }

  if (!detailChanged && !streamsAdded && photos.added === 0) {
    return "ok: nothing changed";
  }

  console.log(
    `Strava activity ${activityId} refreshed: detail ${detailChanged ? "changed" : "unchanged"}, ${photos.added} new photos, streams ${streamsAdded ? "filled" : "unchanged"}`,
  );
  await upsertDetail(
    env,
    activityId,
    JSON.parse(text) as StravaActivityDetail,
    rawKeys,
  );
}

// One Strava read, the photo listing, and nothing else. The backfill population
// came from the bulk export, so it already holds an `original`, and a refresh
// would spend two further reads rewriting detail and streams that did not
// change.
//
// The registry row is therefore updated through a raw-keys merge rather than an
// upsert, which would need the detail this never fetches.
async function archivePhotos(
  activityId: number,
  env: Env,
  options: ConsumeOptions,
): Promise<string | undefined> {
  const client = options.client ?? stravaClient(env);
  const photos = await syncPhotos(
    client,
    env,
    activityId,
    options.fetch ?? globalThis.fetch,
  );
  if (photos.stored + photos.added === 0) {
    return "ok: no photos";
  }

  const keyed = await mergeRawKeys(env.REGISTRY, "strava", String(activityId), {
    photos: photosPrefix(activityId),
  });
  if (photos.added === 0 && !keyed) {
    return "ok: nothing changed";
  }

  console.log(
    `Strava activity ${activityId} photos archived: ${photos.added} new, ${photos.stored} already held`,
  );
}

export async function consumeStravaEvent(
  message: StravaIngestMessage,
  env: Env,
  options: ConsumeOptions = {},
): Promise<string | undefined> {
  if (message.kind === "photos") {
    return archivePhotos(message.objectId, env, options);
  }

  if (message.kind === "refresh") {
    return refreshActivity(message.objectId, env, options);
  }

  // An athlete event's objectId is the athlete, so the log line would
  // otherwise read as an activity that ingested cleanly.
  if (message.objectType === "athlete") {
    console.warn("ignoring Strava athlete event; handled manually");
    return "skipped: athlete event, handled manually";
  }

  const client = options.client ?? stravaClient(env);
  const activityId = message.objectId;

  if (message.kind === "delete") {
    const deleted = await markSourceDeleted(
      env.REGISTRY,
      "strava",
      String(activityId),
    );
    if (deleted !== null) {
      await enqueueActivity(env, deleted, "publish");
    }
    return;
  }

  const text = await fetchDetailText(client, activityId);
  if (text === null) {
    return "skipped: activity not found";
  }
  await env.RAW.put(detailKey(activityId), text);

  const rawKeys: Record<string, string> = { detail: detailKey(activityId) };

  if (message.kind === "create") {
    if (await fetchStreams(client, env, activityId)) {
      rawKeys.streams = streamsKey(activityId);
    }
    const photos = await syncPhotos(
      client,
      env,
      activityId,
      options.fetch ?? globalThis.fetch,
    );
    if (photos.stored + photos.added > 0) {
      rawKeys.photos = photosPrefix(activityId);
    }
  }

  await upsertDetail(
    env,
    activityId,
    JSON.parse(text) as StravaActivityDetail,
    rawKeys,
  );
}
