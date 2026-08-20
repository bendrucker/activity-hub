import { readConsumeLog } from "./consumelog";
import {
  pipelineReport,
  STAGES,
  type DerivedStatus,
  type PipelineReport,
  type Stage,
} from "./derived";
import { RateLimitedError } from "./ingest";
import { buildLake, type LakeBuildOptions } from "./lake/build";
import {
  backfillListedStravaPhotos,
  backfillStravaPhotos,
  backfillStravaStreams,
  PER_RUN,
  seedPhotoBackfillTargets,
  type StravaBackfillOptions,
} from "./strava/backfill";
import {
  reconcileStravaActivities,
  type ReconcileOptions,
  type ReconcileReport,
} from "./strava/reconcile";
import {
  enqueueActivity,
  reconcileTransform,
  RECONCILE_LIMIT,
} from "./transform/enqueue";
import { backfillWahooWorkouts, type BackfillOptions } from "./wahoo/backfill";
import { wahooClient, type WahooClient } from "./wahoo/client";
import { consumeWahooEvent, type ConsumeOptions } from "./wahoo/consume";
import { isWorkoutSummary } from "./wahoo/summary";

function authorized(request: Request, env: Env): boolean {
  return (
    Boolean(env.ADMIN_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`
  );
}

// The admin surface is bearer-authenticated and worker logs are not always
// reachable, so the caller gets the failure itself instead of a bare 1101.
function errorResponse(error: unknown): Response {
  return Response.json(
    {
      ok: false,
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    { status: 500 },
  );
}

export async function handleReconcile(
  request: Request,
  env: Env,
  options: ReconcileOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  let report: ReconcileReport;
  try {
    report = await reconcileStravaActivities(env, options);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return new Response("Strava rate limited, retry after the 15m window", {
        status: 429,
      });
    }
    return errorResponse(error);
  }

  return Response.json({ ok: true, ...report });
}

export interface ProbeOptions {
  client?: WahooClient;
}

// The queue consumer's summary fetch cannot be observed when logs are
// unreachable, so this route runs the identical requests for one workout and
// hands back exactly what Wahoo returned.
export async function handleWahooProbe(
  request: Request,
  env: Env,
  options: ProbeOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  const requested = new URL(request.url).searchParams.get("workout");
  const workoutId = requested === null ? NaN : Number(requested);
  if (!Number.isInteger(workoutId) || workoutId < 1) {
    return new Response("workout must be a positive integer", { status: 400 });
  }

  try {
    const client = options.client ?? wahooClient(env);
    const workoutResponse = await client.fetch(`/v1/workouts/${workoutId}`);
    const workoutText = await workoutResponse.text();
    const summaryResponse = await client.fetch(
      `/v1/workouts/${workoutId}/workout_summary`,
    );
    const summaryText = await summaryResponse.text();

    let guardPassed: boolean | null = null;
    if (workoutResponse.ok && summaryResponse.ok) {
      const summary: unknown = JSON.parse(summaryText);
      const workout: unknown = JSON.parse(workoutText);
      guardPassed =
        typeof summary === "object" &&
        summary !== null &&
        isWorkoutSummary({ ...summary, workout });
    }

    return Response.json({
      workout: {
        status: workoutResponse.status,
        body: workoutText.slice(0, 400),
      },
      summary: {
        status: summaryResponse.status,
        body: summaryText.slice(0, 400),
      },
      guardPassed,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// Runs the queue consumer's full ingest for one workout inside a fetch
// invocation. That makes the consumer's behavior observable next to the
// queue's, and doubles as a recovery path when queue delivery misbehaves.
export async function handleWahooIngest(
  request: Request,
  env: Env,
  options: ConsumeOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  const requested = new URL(request.url).searchParams.get("workout");
  const workoutId = requested === null ? NaN : Number(requested);
  if (!Number.isInteger(workoutId) || workoutId < 1) {
    return new Response("workout must be a positive integer", { status: 400 });
  }

  try {
    const client = options.client ?? wahooClient(env);
    const response = await client.fetch(`/v1/workouts/${workoutId}`);
    if (response.status === 404) {
      return new Response("workout not found", { status: 404 });
    }
    if (response.status === 429) {
      return new Response("Wahoo rate limited, retry after the 5m window", {
        status: 429,
      });
    }
    if (!response.ok) {
      return errorResponse(
        new Error(`Wahoo workout fetch failed: ${response.status}`),
      );
    }
    const entry = (await response.json()) as Record<string, unknown> & {
      id: number;
    };
    const { workout_summary: _listed, ...workout } = entry;
    const outcome = await consumeWahooEvent(
      { source: "wahoo", kind: "workout", workoutId, workout },
      env,
      options,
    );
    const row = await env.REGISTRY.prepare(
      "SELECT activity_id FROM activity_sources WHERE source = 'wahoo' AND source_id = ?1",
    )
      .bind(String(workoutId))
      .first<{ activity_id: string }>();
    return Response.json({
      ok: true,
      ingested: row !== null,
      outcome: outcome ?? "ok",
    });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return new Response("Wahoo rate limited, retry after the 5m window", {
        status: 429,
      });
    }
    return errorResponse(error);
  }
}

export async function handleConsumeLog(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json(await readConsumeLog(env.TOKENS));
}

// Wahoo has no date-filtered listing, so history comes back one page at a
// time. Each call returns the page to resume from, letting the caller drive
// the walk to exhaustion and read the depth of Wahoo's cloud history off the
// last response.
export async function handleStravaBackfill(
  request: Request,
  env: Env,
  options: StravaBackfillOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;

  try {
    return Response.json(
      await backfillStravaStreams(env, { cursor, ...options }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

// A body of `{"ids": [...]}` aims the run at those activities. The list goes
// in the body because a page of ids is a few kilobytes.
function listedIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("ids" in body)) {
    throw new Error("body must be an object with an ids array");
  }
  const { ids } = body as { ids: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  if (!ids.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
    throw new Error("ids must be Strava numeric ids, as strings");
  }
  // Refusing an over-long page: a caller that got a short enqueued count back
  // would have no way to tell a trim from a page whose activities were already
  // archived.
  if (ids.length > PER_RUN) {
    throw new Error(
      `ids is limited to ${PER_RUN} per request, send the rest as further pages`,
    );
  }
  return ids as string[];
}

// Deliberately manual. Every activity swept costs a call to an undocumented
// Strava endpoint, and a run wide enough to cover the archive would spend a
// day's read budget, so nothing schedules this.
export async function handlePhotoBackfill(
  request: Request,
  env: Env,
  options: StravaBackfillOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const limit = params.get("limit");

  const body = await request.text();
  let ids: string[] | null = null;
  if (body.trim() !== "") {
    try {
      ids = listedIds(JSON.parse(body));
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : String(error),
        { status: 400 },
      );
    }
  }

  try {
    return Response.json(
      ids === null
        ? await backfillStravaPhotos(env, {
            cursor: params.get("cursor") ?? undefined,
            ...(limit === null ? {} : { perRun: Number(limit) }),
            ...options,
          })
        : await backfillListedStravaPhotos(env, ids),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

// Seeding spends no Strava read, so the per-request cap bounds nothing but the
// D1 batch. It is kept at PER_RUN anyway so both endpoints take the same page.
export async function handlePhotoBackfillTargets(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  let ids: string[];
  try {
    ids = listedIds(await request.json());
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        status: 400,
      },
    );
  }

  try {
    return Response.json(await seedPhotoBackfillTargets(env, ids));
  } catch (error) {
    return errorResponse(error);
  }
}

interface StaleSummary {
  activityId: string;
  sourceUpdatedAt: string;
  behindS: number | null;
}

interface StageSummary {
  stage: Stage;
  total: number;
  statuses: Record<DerivedStatus, number>;
  parked: number;
  oldestStale: StaleSummary | null;
}

// The lag on the oldest stale activity is what separates a pipeline that is
// keeping up from one that stopped. An unparseable timestamp reports null
// rather than the NaN that would serialize as one anyway.
function behindS(sourceUpdatedAt: string, now: number): number | null {
  const at = Date.parse(sourceUpdatedAt);
  return Number.isFinite(at)
    ? Math.max(0, Math.round((now - at) / 1000))
    : null;
}

// A status absent from the counts has zero rows. Every stage reports all three
// so a reader can take a missing status at face value.
function stageSummary(
  report: PipelineReport,
  stage: Stage,
  now: number,
): StageSummary {
  const statuses: Record<DerivedStatus, number> = {
    ok: 0,
    failed: 0,
    skipped: 0,
  };
  let total = 0;
  for (const entry of report.counts) {
    if (entry.stage === stage) {
      statuses[entry.status] = entry.count;
      total += entry.count;
    }
  }

  const stale = report.oldestStale.find((entry) => entry.stage === stage);
  return {
    stage,
    total,
    statuses,
    // A parked row is failed and out of attempts, so it is absent from
    // oldestStale for the same reason it will never retry. Without this count
    // a stage holding nothing but parked rows reads as caught up.
    parked: report.parked.find((entry) => entry.stage === stage)?.count ?? 0,
    oldestStale:
      stale === undefined
        ? null
        : {
            activityId: stale.activityId,
            sourceUpdatedAt: stale.sourceUpdatedAt,
            behindS: behindS(stale.sourceUpdatedAt, now),
          },
  };
}

// Reading this route is the first step of a recovery, so it carries the failure
// text alongside the counts. A count on its own only sends the reader to
// another query to find out what broke.
export async function handlePipeline(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const report = await pipelineReport(env.REGISTRY);
    const now = Date.now();
    return Response.json({
      ok: true,
      generatedAt: new Date(now).toISOString(),
      stages: STAGES.map((stage) => stageSummary(report, stage, now)),
      failures: report.failures,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// Reprocessing one activity has to stay possible without waiting for a sweep
// to reach it: an upstream edit, a decoder fix, a row that parked as failed.
// Naming the activity does exactly that, and `force` covers the case where the
// raw bytes did not change but what they should produce did.
export async function handleTransform(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const activityId = url.searchParams.get("activityId");
    const stage = (url.searchParams.get("stage") ?? "decode") as Stage;
    if (!STAGES.includes(stage)) {
      return Response.json(
        { ok: false, error: `unknown stage ${stage}` },
        { status: 400 },
      );
    }

    if (activityId !== null) {
      await enqueueActivity(
        env,
        activityId,
        stage,
        url.searchParams.get("force") === "true",
      );
      return Response.json({ ok: true, enqueued: 1, activityId, stage });
    }

    const limit = Number(url.searchParams.get("limit") ?? RECONCILE_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) {
      return Response.json(
        { ok: false, error: `limit must be a positive integer` },
        { status: 400 },
      );
    }
    return Response.json({
      ok: true,
      enqueued: await reconcileTransform(env, limit),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// The lake build takes minutes and rewrites every table, so it stays an
// explicit request rather than something a stale row triggers. The response
// carries the row count per table, which is the only cheap check that a
// rebuild did not quietly drop a table's inputs.
export async function handleLake(
  request: Request,
  env: Env,
  options: LakeBuildOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const result = await buildLake(env, options);
    return Response.json({
      ok: true,
      registry: result.registry,
      stravaExport: result.stravaExport,
      output: result.response.outputKey,
      tables: result.response.tables,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleWahooBackfill(
  request: Request,
  env: Env,
  options: BackfillOptions = {},
): Promise<Response> {
  if (!authorized(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  const requested = new URL(request.url).searchParams.get("page");
  const page = requested === null ? 1 : Number(requested);
  if (!Number.isInteger(page) || page < 1) {
    return new Response("page must be a positive integer", { status: 400 });
  }

  try {
    return Response.json(
      await backfillWahooWorkouts(env, { page, ...options }),
    );
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return new Response("Wahoo rate limited, retry after the 5m window", {
        status: 429,
      });
    }
    return errorResponse(error);
  }
}
