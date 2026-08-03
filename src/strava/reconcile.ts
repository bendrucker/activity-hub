import { RateLimitedError, sendBatched, type IngestMessage } from "../ingest";
import { stravaClient, type StravaClient } from "./client";

// Activities can be uploaded long after they were recorded, so listing from
// the bare high-water mark would miss late uploads. Re-listing an overlap
// window is cheap because the id diff drops anything already ingested.
export const LOOKBACK_OVERLAP_S = 30 * 24 * 60 * 60;

export const PER_PAGE = 200;

export interface ReconcileOptions {
  client?: StravaClient;
}

export interface ReconcileReport {
  enqueued: number;
  refreshed: number;
}

interface StravaActivitySummary {
  id: number;
}

// Every listed activity is already inside the lookback window, so an id the
// registry knows is one whose title or photos may have been edited since it
// was ingested. Sweeping all of them is bounded by how much I ride, roughly
// 40 activities a month, and each refresh costs at most three Strava reads
// against a 1,000/day budget.
export async function reconcileStravaActivities(
  env: Env,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const client = options.client ?? stravaClient(env);
  const after = await lookbackStart(env.REGISTRY);

  const report: ReconcileReport = { enqueued: 0, refreshed: 0 };
  for (let page = 1; ; page++) {
    const activities = await listPage(client, page, after);
    const known = await knownIds(env.REGISTRY, activities);
    const messages: IngestMessage[] = activities.map(({ id }) =>
      known.has(String(id))
        ? { source: "strava", kind: "refresh", objectId: id }
        : {
            source: "strava",
            kind: "create",
            objectType: "activity",
            objectId: id,
            updates: {},
          },
    );
    await sendBatched(env.INGEST_QUEUE, messages);
    for (const message of messages) {
      if (message.kind === "refresh") {
        report.refreshed++;
      } else {
        report.enqueued++;
      }
    }
    if (activities.length < PER_PAGE) {
      return report;
    }
  }
}

async function lookbackStart(db: D1Database): Promise<number | undefined> {
  const row = await db
    .prepare(
      `SELECT MAX(activities.started_at) AS max_started_at
       FROM activities
       JOIN activity_sources ON activity_sources.activity_id = activities.activity_id
       WHERE activity_sources.source = 'strava'`,
    )
    .first<{ max_started_at: string | null }>();
  if (!row?.max_started_at) {
    return undefined;
  }
  return Math.floor(Date.parse(row.max_started_at) / 1000) - LOOKBACK_OVERLAP_S;
}

async function listPage(
  client: StravaClient,
  page: number,
  after: number | undefined,
): Promise<StravaActivitySummary[]> {
  const params = new URLSearchParams({
    per_page: String(PER_PAGE),
    page: String(page),
  });
  if (after !== undefined) {
    params.set("after", String(after));
  }
  const response = await client.fetch(`/athlete/activities?${params}`);
  if (response.status === 429) {
    throw new RateLimitedError("rate limited on /athlete/activities");
  }
  if (!response.ok) {
    throw new Error(
      `Strava activity list failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as StravaActivitySummary[];
}

async function knownIds(
  db: D1Database,
  activities: StravaActivitySummary[],
): Promise<Set<string>> {
  if (activities.length === 0) {
    return new Set();
  }
  const { results } = await db
    .prepare(
      `SELECT source_id FROM activity_sources
       WHERE source = 'strava'
         AND source_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(activities.map((activity) => String(activity.id))))
    .all<{ source_id: string }>();
  return new Set(results.map((row) => row.source_id));
}
