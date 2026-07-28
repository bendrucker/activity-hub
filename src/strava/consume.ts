import { RateLimitedError, type IngestMessage } from "../ingest";
import { markSourceDeleted, upsertSourceRecord } from "../registry";
import { sportFromStrava } from "../sport";
import { stravaClient, type StravaClient } from "./client";

export interface ConsumeOptions {
  client?: StravaClient;
  // For downloading photo CDN URLs, which bypass the StravaClient.
  fetchImpl?: typeof fetch;
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
    throw new RateLimitedError(`rate limited on ${path}`);
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

async function fetchDetail(
  client: StravaClient,
  env: Env,
  activityId: number,
): Promise<StravaActivityDetail | null> {
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
  const text = await response.text();
  await env.RAW.put(detailKey(activityId), text);
  return JSON.parse(text) as StravaActivityDetail;
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

// Undocumented endpoint, so any failure (bad response, bad JSON, download
// error) is failure-tolerant: warn and move on rather than fail the event.
async function fetchPhotos(
  client: StravaClient,
  env: Env,
  activityId: number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const response = await fetchOrThrow(
    client,
    `/activities/${activityId}/photos?size=5000&photo_sources=true`,
  );
  if (!response.ok) {
    console.warn(
      `Strava photos ${activityId} fetch failed: ${response.status}`,
    );
    return false;
  }

  let photos: StravaPhoto[];
  try {
    photos = (await response.json()) as StravaPhoto[];
  } catch {
    console.warn(`Strava photos ${activityId} returned invalid JSON`);
    return false;
  }

  // CDN downloads don't count against the API read budget, so they can
  // overlap freely.
  const wrote = await Promise.all(
    photos.map(async (photo) => {
      const url = largestPhotoUrl(photo);
      if (!url) {
        return false;
      }
      try {
        const download = await fetchImpl(url);
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
    }),
  );
  return wrote.some(Boolean);
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
    timezone: parseTimezone(detail.timezone),
    sport: sportFromStrava(detail.sport_type),
    durationS: detail.elapsed_time,
    rawKeys,
  });
}

export async function consumeStravaEvent(
  message: IngestMessage,
  env: Env,
  options: ConsumeOptions = {},
): Promise<void> {
  if (message.objectType === "athlete") {
    console.warn("ignoring Strava athlete event; handled manually");
    return;
  }

  const client = options.client ?? stravaClient(env);
  const activityId = message.objectId;

  if (message.kind === "delete") {
    await markSourceDeleted(env.REGISTRY, "strava", String(activityId));
    return;
  }

  const detail = await fetchDetail(client, env, activityId);
  if (!detail) {
    return;
  }

  const rawKeys: Record<string, string> = { detail: detailKey(activityId) };

  if (message.kind === "create") {
    if (await fetchStreams(client, env, activityId)) {
      rawKeys.streams = streamsKey(activityId);
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    if (await fetchPhotos(client, env, activityId, fetchImpl)) {
      rawKeys.photos = photosPrefix(activityId);
    }
  }

  await upsertDetail(env, activityId, detail, rawKeys);
}
