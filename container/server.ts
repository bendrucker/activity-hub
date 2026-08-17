import { decodeBatch, type DecodeDeps } from "./decode";
import { buildLake, type LakeDeps } from "./lake";
import { publishActivity, type PublishDeps } from "./publish";
import type {
  DecodeRequest,
  DecodeWork,
  LakeRequest,
  PublishRequest,
} from "../src/transform/protocol";

export function routes(deps: DecodeDeps & LakeDeps & PublishDeps) {
  return {
    "/health": () => new Response("ok"),
    "/decode": {
      POST: (request: Request) => decode(request, deps),
    },
    "/lake": {
      POST: (request: Request) => lake(request, deps),
    },
    "/publish": {
      POST: (request: Request) => publish(request, deps),
    },
  };
}

// One activity per request, so the outcome carries the failure the same way a
// decode outcome does and the Worker never retries a whole batch for one bad
// artifact.
export async function publish(
  request: Request,
  deps: PublishDeps,
): Promise<Response> {
  const parsed = parsePublishRequest(await body(request));
  if (parsed === null) {
    return Response.json(
      { error: "expected { work: { activityId, decode } }" },
      { status: 400 },
    );
  }
  return Response.json(await publishActivity(parsed, deps));
}

// The lake build is one indivisible unit: there is no per-item outcome to
// report, and any failure is the whole request's.
export async function lake(
  request: Request,
  deps: LakeDeps,
): Promise<Response> {
  const parsed = parseLakeRequest(await body(request));
  if (parsed === null) {
    return Response.json(
      { error: "expected { decode, registry, stravaExport, output }" },
      { status: 400 },
    );
  }
  return Response.json(await buildLake(parsed, deps));
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

function parseLakeRequest(body: unknown): LakeRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { decode, registry, stravaExport, output } = body as Record<
    string,
    unknown
  >;
  if (
    typeof decode !== "string" ||
    typeof registry !== "string" ||
    typeof output !== "string" ||
    (stravaExport !== null && typeof stravaExport !== "string")
  ) {
    return null;
  }
  return { decode, registry, stravaExport, output };
}

function parsePublishRequest(body: unknown): PublishRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const item = (body as Record<string, unknown>).work;
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const { activityId, decode } = item as Record<string, unknown>;
  if (typeof activityId !== "string" || typeof decode !== "string") {
    return null;
  }
  return { work: { activityId, decode } };
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
