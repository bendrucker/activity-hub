import { decodeBatch, type DecodeDeps } from "./decode";
import type { DecodeRequest, DecodeWork } from "../src/transform/protocol";

export function routes(deps: DecodeDeps) {
  return {
    "/health": () => new Response("ok"),
    "/decode": {
      POST: (request: Request) => decode(request, deps),
    },
  };
}

// A malformed body is the one case that answers non-2xx. Anything the
// container can attribute to a single activity comes back as that activity's
// outcome instead, because the Worker retries the whole batch on any other
// status.
export async function decode(
  request: Request,
  deps: DecodeDeps,
): Promise<Response> {
  const parsed = parseDecodeRequest(await body(request));
  if (parsed === null) {
    return Response.json(
      { error: "expected { work: DecodeWork[] }" },
      { status: 400 },
    );
  }
  return Response.json(await decodeBatch(parsed, deps));
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseDecodeRequest(body: unknown): DecodeRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const items = (body as Record<string, unknown>).work;
  if (!Array.isArray(items)) {
    return null;
  }

  const work: DecodeWork[] = [];
  for (const item of items) {
    const parsed = parseDecodeWork(item);
    if (parsed === null) {
      return null;
    }
    work.push(parsed);
  }
  return { work };
}

function parseDecodeWork(item: unknown): DecodeWork | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const { activityId, rawKeys } = item as Record<string, unknown>;
  if (typeof activityId !== "string" || !Array.isArray(rawKeys)) {
    return null;
  }

  const keys: string[] = [];
  for (const key of rawKeys) {
    if (typeof key !== "string") {
      return null;
    }
    keys.push(key);
  }
  return { activityId, rawKeys: keys };
}
