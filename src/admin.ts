import { RateLimitedError } from "./ingest";
import {
  reconcileStravaActivities,
  type ReconcileOptions,
} from "./strava/reconcile";

export async function handleReconcile(
  request: Request,
  env: Env,
  options: ReconcileOptions = {},
): Promise<Response> {
  const authorization = request.headers.get("Authorization");
  if (!env.ADMIN_TOKEN || authorization !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("Forbidden", { status: 403 });
  }

  let enqueued: number;
  try {
    enqueued = await reconcileStravaActivities(env, options);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return new Response("Strava rate limited, retry after the 15m window", {
        status: 429,
      });
    }
    throw error;
  }

  return Response.json({ ok: true, enqueued });
}
