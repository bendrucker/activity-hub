import {
  RateLimitedError,
  type WahooIngestMessage,
  retryAfterS,
} from "../ingest";
import { trackTimezone } from "../import/timezone";
import { extractTrack } from "../import/track";
import { upsertSourceRecord } from "../registry";
import { wahooClient, type WahooClient } from "./client";
import {
  isWorkoutSummary,
  summaryFileUrl,
  summarySourceRecord,
  type ResolvedTimezone,
  type WahooWorkoutSummary,
} from "./summary";

export interface ConsumeOptions {
  fetchImpl?: typeof fetch;
  client?: WahooClient;
}

function summaryKey(workoutId: number): string {
  return `raw/wahoo/workouts/${workoutId}/summary.json`;
}

function fitKey(workoutId: number): string {
  return `raw/wahoo/workouts/${workoutId}/original.fit`;
}

// BIKING_INDOOR_VIRTUAL and RUNNING_INDOOR_VIRTUAL carry in-game course
// GPS, which says nothing about where the athlete was.
const VIRTUAL_WORKOUT_TYPES = new Set([68, 71]);

// A FIT that fails to decode still gets archived. It just cannot vote on
// timezone. The virtual-workout guard already ran, so the sport type
// passed to trackTimezone is never virtual.
async function fitTimezone(bytes: Uint8Array): Promise<string | null> {
  try {
    return trackTimezone(await extractTrack(bytes, "original.fit"), "");
  } catch (error) {
    console.warn(`Wahoo FIT track extraction failed: ${String(error)}`);
    return null;
  }
}

// The payload has no timezone and a trainer ride's FIT has no GPS. Same call
// as the export importer: borrow the zone of the nearest-in-time activity
// that has one, which is usually the Strava twin of this very workout. UTC
// only when the registry is empty.
async function nearestTimezone(
  db: D1Database,
  startedAt: string,
): Promise<string> {
  const row = await db
    .prepare(
      "SELECT timezone FROM activities ORDER BY abs(unixepoch(started_at) - unixepoch(?1)) LIMIT 1",
    )
    .bind(startedAt)
    .first<{ timezone: string }>();
  return row?.timezone ?? "UTC";
}

async function resolveTimezone(
  env: Env,
  summary: WahooWorkoutSummary,
  fitBytes: Uint8Array | null,
): Promise<ResolvedTimezone> {
  const virtual = VIRTUAL_WORKOUT_TYPES.has(summary.workout.workout_type_id);
  const fromTrack =
    virtual || fitBytes === null ? null : await fitTimezone(fitBytes);
  if (fromTrack) {
    return { timezone: fromTrack, inferred: false };
  }
  return {
    timezone: await nearestTimezone(env.REGISTRY, summary.workout.starts),
    inferred: true,
  };
}

// A backfill message names a workout the list endpoint reported, and the
// summary lives behind its own endpoint. Running that fetch here rather than
// in the backfill route gives every workout a fresh subrequest allowance.
async function messageSummary(
  message: WahooIngestMessage,
  env: Env,
  options: ConsumeOptions,
): Promise<WahooWorkoutSummary | null> {
  if (message.kind === "workout_summary") {
    return message.summary;
  }

  const client = options.client ?? wahooClient(env);
  const fetched = await fetchSummary(client, message.workoutId);
  if (typeof fetched !== "object" || fetched === null) {
    return null;
  }
  // The summary endpoint returns the summary alone, while ingest reads the
  // webhook's shape, which nests the workout inside it.
  const candidate = { ...fetched, workout: message.workout };
  return isWorkoutSummary(candidate) ? candidate : null;
}

async function fetchSummary(
  client: WahooClient,
  workoutId: number,
): Promise<unknown> {
  const response = await client.fetch(
    `/v1/workouts/${workoutId}/workout_summary`,
  );
  // A workout that was planned but never recorded has no summary. Wahoo
  // answers for one with either a 404 or a 401. The client hands a 401 on a
  // live token straight back, so this one belongs to the workout.
  if (response.status === 404 || response.status === 401) {
    return null;
  }
  if (response.status === 429) {
    throw new RateLimitedError(
      "rate limited on /v1/workouts/:id/summary",
      retryAfterS(response),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Wahoo workout summary failed for ${workoutId}: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

export async function consumeWahooEvent(
  message: WahooIngestMessage,
  env: Env,
  options: ConsumeOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { workoutId } = message;

  const summary = await messageSummary(message, env, options);
  if (!summary) {
    console.warn(`skipping Wahoo workout ${workoutId} with no summary file`);
    return;
  }

  // CDN downloads are exempt from rate limits, and re-downloading on Wahoo's
  // duplicate deliveries is what keeps file-update events correct: same key,
  // fresh bytes. Early ELEMNT-era workouts have no file at all, and their
  // summary is still worth the registry row.
  const fileUrl = summaryFileUrl(summary);
  let fitBytes: Uint8Array | null = null;
  if (fileUrl !== null) {
    const download = await fetchImpl(fileUrl);
    if (!download.ok) {
      throw new Error(
        `Wahoo FIT download failed for workout ${workoutId}: ${download.status}`,
      );
    }
    fitBytes = new Uint8Array(await download.arrayBuffer());
  }

  await env.RAW.put(summaryKey(workoutId), JSON.stringify(summary));
  const rawKeys: Record<string, string> = { summary: summaryKey(workoutId) };
  if (fitBytes !== null) {
    await env.RAW.put(fitKey(workoutId), fitBytes);
    rawKeys.original = fitKey(workoutId);
  }

  await upsertSourceRecord(
    env.REGISTRY,
    summarySourceRecord(
      summary,
      await resolveTimezone(env, summary, fitBytes),
      rawKeys,
    ),
  );
}
