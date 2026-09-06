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

// How long the instance may sit allocated with nothing running before it is
// destroyed. The library's own two-minute inactivity timer should have fired
// long before this, so reaching it means the timer is stuck.
const IDLE_LIMIT_SECONDS = 10 * 60;

// A lake build runs in the background with no request in flight, so an idle
// instance is not necessarily a free one. Accepting a build extends the
// deadline by this instead, well past the ~12 minutes a build takes.
const LAKE_BUILD_SECONDS = 90 * 60;

// A `/lake` POST the container accepted, as opposed to one it refused as busy.
export function acceptedLakeBuild(request: Request, response: Response): boolean {
  return new URL(request.url).pathname === "/lake" && response.status === 202;
}

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

  // When the instance was last doing something. Held in memory rather than in
  // storage because the pin this guards against lasts exactly as long as the
  // Durable Object does: the library's alarm loop keeps the object and the
  // stuck counter alive together, and an object the platform recycles takes
  // the pin with it.
  private busyUntil = 0;

  // One idle chain at a time. Two chains would each reschedule the other's
  // successor, and the pair would keep doubling.
  private idleCheckScheduled = false;

  // The lake build defers SIGTERM until it settles, so a build that hangs
  // would hold the instance indefinitely. This timer caps any pin of the
  // instance at three hours, triple the ~55-minute build. The schedule
  // persists in the Durable Object's storage and deletes after firing. A
  // stale timer firing while the container sleeps no-ops below. One landing
  // during a later wake can kill a 30-second decode batch, which the queue
  // retries.
  override async onStart(): Promise<void> {
    this.extendBusy(IDLE_LIMIT_SECONDS);
    await this.schedule(3 * 3600, "watchdogStop");
    await this.scheduleIdleCheck();
  }

  // The library holds the instance awake while it counts a request as in
  // flight, and a Worker invocation killed between the response arriving and
  // its body being read leaves that count stuck above zero for good
  // (cloudflare/containers#241, #242), so `sleepAfter` never fires. This
  // tracks activity on the Worker side, where the count cannot lie.
  override async fetch(request: Request): Promise<Response> {
    // Before as well as after: a request still in flight is activity, and a
    // decode runs up to 30 seconds.
    this.extendBusy(IDLE_LIMIT_SECONDS);
    const response = await super.fetch(request);
    this.extendBusy(acceptedLakeBuild(request, response) ? LAKE_BUILD_SECONDS : IDLE_LIMIT_SECONDS);
    return response;
  }

  async idleStop(): Promise<void> {
    this.idleCheckScheduled = false;
    if (!this.ctx.container?.running) {
      return;
    }
    // A Durable Object revived around a running container has no deadline yet.
    // Start one rather than read the zero as an expiry and kill live work.
    if (this.busyUntil === 0) {
      this.extendBusy(IDLE_LIMIT_SECONDS);
    }
    if (Date.now() < this.busyUntil) {
      await this.scheduleIdleCheck();
      return;
    }
    await this.destroy();
  }

  async watchdogStop(): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }
    // destroy() sends SIGKILL. The drain path ignores SIGTERM while a build
    // runs, so a signal the container may defer cannot serve as a backstop.
    await this.destroy();
  }

  private extendBusy(seconds: number): void {
    this.busyUntil = Math.max(this.busyUntil, Date.now() + seconds * 1000);
  }

  private async scheduleIdleCheck(): Promise<void> {
    if (this.idleCheckScheduled) {
      return;
    }
    this.idleCheckScheduled = true;
    const seconds = Math.max(1, Math.ceil((this.busyUntil - Date.now()) / 1000));
    await this.schedule(seconds, "idleStop");
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
