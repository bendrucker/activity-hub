import { Container, getContainer } from "@cloudflare/containers";
import type {
  DecodeRequest,
  DecodeResponse,
  LakeRequest,
  LakeResponse,
  PublishRequest,
  PublishResponse,
} from "./protocol";

export class DecodeContainer extends Container<Env> {
  defaultPort = 8080;
  // Reprocessing arrives as a burst of batches. Holding the instance between
  // them turns a cold start per batch into one for the whole run.
  sleepAfter = "10m";

  // Bindings do not cross into a container, so R2 reaches it as credentials.
  // These are Worker secrets, forwarded rather than baked into the image.
  override envVars = {
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
    R2_RAW_ACCESS_KEY_ID: this.env.R2_RAW_ACCESS_KEY_ID,
    R2_RAW_SECRET_ACCESS_KEY: this.env.R2_RAW_SECRET_ACCESS_KEY,
    R2_LAKE_ACCESS_KEY_ID: this.env.R2_LAKE_ACCESS_KEY_ID,
    R2_LAKE_SECRET_ACCESS_KEY: this.env.R2_LAKE_SECRET_ACCESS_KEY,
  };
}

export interface DecodeClient {
  decode(request: DecodeRequest): Promise<DecodeResponse>;
}

export interface LakeClient {
  build(request: LakeRequest): Promise<LakeResponse>;
}

export interface PublishClient {
  summarize(request: PublishRequest): Promise<PublishResponse>;
}

// Every batch lands on the same instance. The work is CPU-bound inside the
// container and it paces itself across its own vCPUs, so spreading batches over
// several instances would multiply cold starts and memory without decoding any
// faster.
const INSTANCE = "decode";

export function decodeClient(env: Env): DecodeClient {
  return {
    decode: (request) => call(env, "decode", request),
  };
}

export function lakeClient(env: Env): LakeClient {
  return {
    build: (request) => call(env, "lake", request),
  };
}

export function publishClient(env: Env): PublishClient {
  return {
    summarize: (request) => call(env, "publish", request),
  };
}

async function call<T>(env: Env, route: string, request: unknown): Promise<T> {
  const container = getContainer(env.DECODE_CONTAINER, INSTANCE);
  const response = await container.fetch(`http://container/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(
      `${route} container returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}
