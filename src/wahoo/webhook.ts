import type { IngestMessage } from "../ingest";
import type { WahooWorkoutSummary } from "./summary";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkoutSummary(value: unknown): value is WahooWorkoutSummary {
  if (!isRecord(value)) {
    return false;
  }
  const { file, workout } = value;
  return (
    isRecord(file) &&
    typeof file.url === "string" &&
    isRecord(workout) &&
    Number.isInteger(workout.id) &&
    typeof workout.starts === "string" &&
    typeof workout.minutes === "number" &&
    typeof workout.workout_type_id === "number"
  );
}

export async function handleWebhookEvent(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  if (
    !env.WAHOO_WEBHOOK_TOKEN ||
    body.webhook_token !== env.WAHOO_WEBHOOK_TOKEN
  ) {
    console.warn("rejected Wahoo webhook event with bad webhook_token");
    return new Response("Forbidden", { status: 403 });
  }

  const summary = body.workout_summary;
  if (body.event_type !== "workout_summary" || !isWorkoutSummary(summary)) {
    // Wahoo retries non-200s for three days, so an event this receiver will
    // never accept gets acked and logged.
    console.warn(
      `ignoring Wahoo webhook event with event_type=${String(body.event_type)}`,
    );
    return new Response(null, { status: 200 });
  }

  const message: IngestMessage = {
    source: "wahoo",
    kind: "workout_summary",
    workoutId: summary.workout.id,
    summary,
  };
  await env.INGEST_QUEUE.send(message);
  return new Response(null, { status: 200 });
}
