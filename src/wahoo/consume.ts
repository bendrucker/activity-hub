import type { WahooIngestMessage } from "../ingest";
import { trackTimezone } from "../import/timezone";
import { extractTrack } from "../import/track";
import { upsertSourceRecord } from "../registry";
import { summarySourceRecord, type WahooWorkoutSummary } from "./summary";

export interface ConsumeOptions {
  fetchImpl?: typeof fetch;
}

function summaryKey(workoutId: number): string {
  return `raw/wahoo/workouts/${workoutId}/summary.json`;
}

function fitKey(workoutId: number): string {
  return `raw/wahoo/workouts/${workoutId}/original.fit`;
}

// A FIT that fails to decode still gets archived. It just cannot vote on
// timezone.
async function fitTimezone(bytes: Uint8Array): Promise<string | null> {
  try {
    return trackTimezone(await extractTrack(bytes, "original.fit"));
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
  fitBytes: Uint8Array,
): Promise<string> {
  return (
    (await fitTimezone(fitBytes)) ??
    nearestTimezone(env.REGISTRY, summary.workout.starts)
  );
}

export async function consumeWahooEvent(
  message: WahooIngestMessage,
  env: Env,
  options: ConsumeOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { summary, workoutId } = message;

  // CDN downloads are exempt from rate limits, and re-downloading on Wahoo's
  // duplicate deliveries is what keeps file-update events correct: same key,
  // fresh bytes.
  const download = await fetchImpl(summary.file.url);
  if (!download.ok) {
    throw new Error(
      `Wahoo FIT download failed for workout ${workoutId}: ${download.status}`,
    );
  }
  const fitBytes = new Uint8Array(await download.arrayBuffer());

  await env.RAW.put(summaryKey(workoutId), JSON.stringify(summary));
  await env.RAW.put(fitKey(workoutId), fitBytes);

  await upsertSourceRecord(
    env.REGISTRY,
    summarySourceRecord(
      summary,
      await resolveTimezone(env, summary, fitBytes),
      {
        summary: summaryKey(workoutId),
        original: fitKey(workoutId),
      },
    ),
  );
}
