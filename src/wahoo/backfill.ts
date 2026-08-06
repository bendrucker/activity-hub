import {
  RateLimitedError,
  sendBatched,
  type IngestMessage,
  retryAfterS,
} from "../ingest";
import { wahooClient, type WahooClient } from "./client";

// /v1/workouts takes no date filters and sorts by start descending, so the
// only way back through history is page by page.
export const PER_PAGE = 30;

// Every page costs one list fetch, one D1 diff, and up to PER_PAGE queue
// sends, all of which count against workerd's per-invocation subrequest cap.
// One page per run leaves headroom under it, and the caller walks history by
// looping on nextPage.
export const PAGES_PER_RUN = 1;

export interface BackfillOptions {
  client?: WahooClient;
  page?: number;
  pages?: number;
}

export interface BackfillResult {
  pagesFetched: number;
  workoutsSeen: number;
  enqueued: number;
  oldestStartedAt: string | null;
  done: boolean;
  nextPage?: number;
}

interface WahooListWorkout {
  id: number;
  starts: string;
  workout_summary?: unknown;
  [field: string]: unknown;
}

interface WorkoutsPage {
  workouts: WahooListWorkout[];
  perPage: number;
}

export async function backfillWahooWorkouts(
  env: Env,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const client = options.client ?? wahooClient(env);
  const startPage = options.page ?? 1;
  const maxPages = options.pages ?? PAGES_PER_RUN;

  let pagesFetched = 0;
  let workoutsSeen = 0;
  let enqueued = 0;
  let oldestStartedAt: string | null = null;
  const progress = () => ({
    pagesFetched,
    workoutsSeen,
    enqueued,
    oldestStartedAt,
  });

  for (let page = startPage; pagesFetched < maxPages; page++) {
    const { workouts, perPage } = await listPage(client, page);
    pagesFetched++;
    workoutsSeen += workouts.length;
    for (const workout of workouts) {
      oldestStartedAt = older(oldestStartedAt, workout.starts);
    }
    enqueued += await enqueueMissing(env, workouts);

    if (workouts.length < perPage) {
      return { ...progress(), done: true };
    }
  }

  return { ...progress(), done: false, nextPage: startPage + pagesFetched };
}

function older(current: string | null, candidate: string): string {
  if (current === null) {
    return candidate;
  }
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

async function listPage(
  client: WahooClient,
  page: number,
): Promise<WorkoutsPage> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(PER_PAGE),
  });
  const response = await client.fetch(`/v1/workouts?${params}`);
  if (response.status === 429) {
    throw new RateLimitedError(
      "rate limited on /v1/workouts",
      retryAfterS(response),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Wahoo workout list failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as Partial<{
    workouts: WahooListWorkout[];
    per_page: number;
  }>;
  // Wahoo may cap per_page below what was asked for, and the short-page test
  // for the last page is only sound against the size it actually served.
  return { workouts: body.workouts ?? [], perPage: body.per_page ?? PER_PAGE };
}

async function enqueueMissing(
  env: Env,
  workouts: WahooListWorkout[],
): Promise<number> {
  const missing = await missingWorkouts(env.REGISTRY, workouts);
  const messages: IngestMessage[] = missing.map((entry) => {
    // The list nests a summary that never carries a file URL in practice.
    // Dropping it keeps the message small and the consumer's fetch honest.
    const { workout_summary: _listed, ...workout } = entry;
    return {
      source: "wahoo",
      kind: "workout",
      workoutId: entry.id,
      workout,
    };
  });
  await sendBatched(env.INGEST_QUEUE, messages);
  return missing.length;
}

async function missingWorkouts(
  db: D1Database,
  workouts: WahooListWorkout[],
): Promise<WahooListWorkout[]> {
  if (workouts.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare(
      `SELECT source_id FROM activity_sources
       WHERE source = 'wahoo'
         AND source_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(workouts.map((workout) => String(workout.id))))
    .all<{ source_id: string }>();
  const known = new Set(results.map((row) => row.source_id));
  return workouts.filter((workout) => !known.has(String(workout.id)));
}
