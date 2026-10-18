import type { IngestMessage } from "../ingest";
import { ingestAttributes } from "../trace";
import { isWorkoutSummary } from "./summary";

export async function handleWebhookEvent(
  request: Request,
  env: Env,
  span?: Span,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  if (!env.WAHOO_WEBHOOK_TOKEN || body.webhook_token !== env.WAHOO_WEBHOOK_TOKEN) {
    console.warn("rejected Wahoo webhook event with bad webhook_token");
    return new Response("Forbidden", { status: 403 });
  }

  const summary = body.workout_summary;
  if (body.event_type !== "workout_summary" || !isWorkoutSummary(summary)) {
    // Wahoo retries non-200s for three days, so an event this receiver will
    // never accept gets acked and logged.
    console.warn(`ignoring Wahoo webhook event with event_type=${String(body.event_type)}`);
    return new Response(null, { status: 200 });
  }

  const message: IngestMessage = {
    source: "wahoo",
    kind: "workout_summary",
    workoutId: summary.workout.id,
    summary,
  };
  span?.setAttributes(ingestAttributes(message));
  await env.INGEST_QUEUE.send(message);
  return new Response(null, { status: 200 });
}
