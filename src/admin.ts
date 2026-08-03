import { RateLimitedError } from "./ingest";
import {
  reconcileStravaActivities,
  type ReconcileOptions,
  type ReconcileReport,
} from "./strava/reconcile";
import { backfillWahooWorkouts, type BackfillOptions } from "./wahoo/backfill";

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

// Wahoo has no date-filtered listing, so history comes back one page at a
// time. Each call returns the page to resume from, letting the caller drive
// the walk to exhaustion and read the depth of Wahoo's cloud history off the
// last response.
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
