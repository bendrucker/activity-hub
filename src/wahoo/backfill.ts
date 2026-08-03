import { RateLimitedError, type IngestMessage } from "../ingest";
import { wahooClient, type WahooClient } from "./client";
import { isWorkoutSummary, type WahooWorkoutSummary } from "./summary";

// /v1/workouts takes no date filters and sorts by start descending, so the
// only way back through history is page by page.
export const PER_PAGE = 30;

// A run is bounded twice: by pages, so a response comes back inside the
// request timeout, and by API requests, so a caller looping without pause
// stays inside the production tier's 200 requests per 5 minutes.
export const PAGES_PER_RUN = 10;
export const REQUEST_BUDGET = 100;

export interface BackfillOptions {
  client?: WahooClient;
  page?: number;
  pages?: number;
}

export interface BackfillResult {
  pagesFetched: number;
  workoutsSeen: number;
  enqueued: number;
  skipped: number;
  apiRequests: number;
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

// Counts requests against the rate-limit budget, which the page loop reads to
// decide whether it can afford another page.
class MeteredClient {
  requests = 0;

  constructor(private readonly client: WahooClient) {}

  fetch(path: string): Promise<Response> {
    this.requests++;
    return this.client.fetch(path);
  }
}

export async function backfillWahooWorkouts(
  env: Env,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const client = new MeteredClient(options.client ?? wahooClient(env));
  const startPage = options.page ?? 1;
  const maxPages = options.pages ?? PAGES_PER_RUN;

  let pagesFetched = 0;
  let workoutsSeen = 0;
  let enqueued = 0;
  let skipped = 0;
  let oldestStartedAt: string | null = null;
  const progress = () => ({
    pagesFetched,
    workoutsSeen,
    enqueued,
    skipped,
    apiRequests: client.requests,
    oldestStartedAt,
  });

  for (let page = startPage; pagesFetched < maxPages; page++) {
    const { workouts, perPage } = await listPage(client, page);
    pagesFetched++;
    workoutsSeen += workouts.length;
    for (const workout of workouts) {
      oldestStartedAt = older(oldestStartedAt, workout.starts);
    }
    const outcome = await enqueueMissing(env, client, workouts);
    enqueued += outcome.enqueued;
    skipped += outcome.skipped;

    if (workouts.length < perPage) {
      return { ...progress(), done: true };
    }
    if (client.requests >= REQUEST_BUDGET) {
      return { ...progress(), done: false, nextPage: page + 1 };
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
  client: MeteredClient,
  page: number,
): Promise<WorkoutsPage> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(PER_PAGE),
  });
  const response = await client.fetch(`/v1/workouts?${params}`);
  if (response.status === 429) {
    throw new RateLimitedError("rate limited on /v1/workouts");
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

interface EnqueueOutcome {
  enqueued: number;
  skipped: number;
}

async function enqueueMissing(
  env: Env,
  client: MeteredClient,
  workouts: WahooListWorkout[],
): Promise<EnqueueOutcome> {
  let enqueued = 0;
  let skipped = 0;
  for (const workout of await missingWorkouts(env.REGISTRY, workouts)) {
    const summary = await ingestSummary(client, workout);
    if (!summary) {
      skipped++;
      continue;
    }
    const message: IngestMessage = {
      source: "wahoo",
      kind: "workout_summary",
      workoutId: summary.workout.id,
      summary,
    };
    await env.INGEST_QUEUE.send(message);
    enqueued++;
  }
  return { enqueued, skipped };
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

// The list nests the summary inside the workout while ingest expects the
// webhook's shape, which nests the workout inside the summary. A list entry
// that carries no usable summary costs one extra call to the dedicated
// endpoint, which is where file.url lives.
async function ingestSummary(
  client: MeteredClient,
  workout: WahooListWorkout,
): Promise<WahooWorkoutSummary | null> {
  const { workout_summary: listed, ...fields } = workout;
  const fromList = assemble(listed, fields);
  if (fromList) {
    return fromList;
  }

  const fetched = assemble(await fetchSummary(client, workout.id), fields);
  if (!fetched) {
    console.warn(`skipping Wahoo workout ${workout.id} with no summary file`);
  }
  return fetched;
}

function assemble(
  summary: unknown,
  workout: Record<string, unknown>,
): WahooWorkoutSummary | null {
  if (typeof summary !== "object" || summary === null) {
    return null;
  }
  const candidate = { ...summary, workout };
  return isWorkoutSummary(candidate) ? candidate : null;
}

async function fetchSummary(
  client: MeteredClient,
  workoutId: number,
): Promise<unknown> {
  const response = await client.fetch(
    `/v1/workouts/${workoutId}/workout_summary`,
  );
  // A workout that was planned but never recorded has no summary and no file.
  if (response.status === 404) {
    return null;
  }
  // Wahoo has returned 401 for individual workouts even against a fresh
  // token, which client.fetch's own 401 retry doesn't fix since it's
  // workout-level rather than a stale-token issue. Treated as skippable
  // like 404, logged by the caller alongside every other missing summary.
  if (response.status === 401) {
    return null;
  }
  if (response.status === 429) {
    throw new RateLimitedError("rate limited on /v1/workouts/:id/summary");
  }
  if (!response.ok) {
    throw new Error(
      `Wahoo workout summary failed for ${workoutId}: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}
