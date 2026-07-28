import type { IngestMessage } from "../ingest";

const OBJECT_TYPES = ["activity", "athlete"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

const ASPECT_TYPES = ["create", "update", "delete"] as const;
type AspectType = (typeof ASPECT_TYPES)[number];

function isOneOf<T extends string>(
  values: readonly T[],
): (value: unknown) => value is T {
  return (value): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);
}

const isObjectType = isOneOf(OBJECT_TYPES);
const isAspectType = isOneOf(ASPECT_TYPES);

export function handleWebhookVerify(url: URL, env: Env): Response {
  const verifyToken = url.searchParams.get("hub.verify_token");
  if (!env.STRAVA_VERIFY_TOKEN || verifyToken !== env.STRAVA_VERIFY_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const challenge = url.searchParams.get("hub.challenge");
  if (!challenge) {
    return new Response("missing hub.challenge", { status: 400 });
  }

  return Response.json({ "hub.challenge": challenge });
}

function toUpdates(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const updates: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    updates[key] = String(entry);
  }
  return updates;
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

  const subscriptionId = body.subscription_id;
  if (
    !env.STRAVA_SUBSCRIPTION_ID ||
    String(subscriptionId) !== env.STRAVA_SUBSCRIPTION_ID
  ) {
    console.warn(
      `rejected Strava webhook event for unknown subscription ${String(subscriptionId)}`,
    );
    return new Response("Forbidden", { status: 403 });
  }

  const aspectType = body.aspect_type;
  const objectType = body.object_type;
  const objectId = Number(body.object_id);
  if (
    !isAspectType(aspectType) ||
    !isObjectType(objectType) ||
    !Number.isInteger(objectId)
  ) {
    // A 4xx here would make Strava retry an event we'll never accept, and a
    // NaN objectId would serialize to null in the queue message.
    console.warn(
      `ignoring Strava webhook event with aspect_type=${String(body.aspect_type)} object_type=${String(body.object_type)} object_id=${String(body.object_id)}`,
    );
    return new Response(null, { status: 200 });
  }

  const message: IngestMessage = {
    source: "strava",
    kind: aspectType,
    objectType,
    objectId,
    updates: toUpdates(body.updates),
  };
  await env.INGEST_QUEUE.send(message);
  return new Response(null, { status: 200 });
}
