import { Container, getContainer } from "@cloudflare/containers";
import type {
  DecodeRequest,
  DecodeResponse,
  LakeAccepted,
  LakeRequest,
  LakeStart,
  PublishRequest,
  PublishResponse,
} from "./protocol";

export class DecodeContainer extends Container<Env> {
  defaultPort = 8080;
  // Reprocessing arrives as a burst of batches. Holding the instance between
  // them turns a cold start per batch into one for the whole run, and a batch
  // times out after 30 seconds, so two minutes covers the gap.
  //
  // Idle time is the whole cost of this container: memory and disk bill on
  // wall clock and only vCPU bills on work. The free allowance is 25 GiB-hours
  // a month, which at 6 GiB is four hours of uptime, so every minute held past
  // the burst is paid for.
  sleepAfter = "2m";

  // Bindings do not cross into a container, so R2 reaches it as credentials.
  // These are Worker secrets, forwarded rather than baked into the image.
  override envVars = {
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
    R2_RAW_ACCESS_KEY_ID: this.env.R2_RAW_ACCESS_KEY_ID,
    R2_RAW_SECRET_ACCESS_KEY: this.env.R2_RAW_SECRET_ACCESS_KEY,
    R2_LAKE_ACCESS_KEY_ID: this.env.R2_LAKE_ACCESS_KEY_ID,
    R2_LAKE_SECRET_ACCESS_KEY: this.env.R2_LAKE_SECRET_ACCESS_KEY,
  };

  // The lake build defers SIGTERM until it settles, so a build that hangs
  // would hold the instance indefinitely. This timer caps any pin of the
  // instance at three hours, triple the ~55-minute build. The schedule
  // persists in the Durable Object's storage and deletes after firing. A
  // stale timer firing while the container sleeps no-ops below. One landing
  // during a later wake can kill a 30-second decode batch, which the queue
  // retries.
  override async onStart(): Promise<void> {
    await this.schedule(3 * 3600, "watchdogStop");
  }

  async watchdogStop(): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }
    // destroy() sends SIGKILL. The drain path ignores SIGTERM while a build
    // runs, so a signal the container may defer cannot serve as a backstop.
    await this.destroy();
  }
}

export interface DecodeClient {
  decode(request: DecodeRequest): Promise<DecodeResponse>;
}

export interface LakeClient {
  build(request: LakeRequest): Promise<LakeStart>;
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

// The container only accepts the build, which runs long past any caller's
// wall clock, so a 409 means the tables are already being rebuilt. That is
// what the caller wanted.
export function lakeClient(env: Env): LakeClient {
  return {
    async build(request) {
      const container = getContainer(env.DECODE_CONTAINER, INSTANCE);
      const response = await container.fetch("http://container/lake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (response.status === 409) {
        // The body still has to be read: the library counts a response as in
        // flight until its body is consumed, and that counter is what holds
        // the container awake.
        await response.text();
        return { accepted: false };
      }
      if (!response.ok) {
        throw new Error(`lake container returned ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as LakeAccepted;
    },
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
    throw new Error(`${route} container returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}
