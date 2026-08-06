import {
  handleConsumeLog,
  handleReconcile,
  handleWahooBackfill,
  handleWahooIngest,
  handleWahooProbe,
} from "./admin";
import {
  appendConsumeLog,
  consumeLogEntry,
  type ConsumeLogEntry,
} from "./consumelog";
import { RateLimitedError, type IngestMessage } from "./ingest";
import { consumeStravaEvent } from "./strava/consume";
import { reconcileStravaActivities } from "./strava/reconcile";
import {
  handleAuthorize as stravaAuthorize,
  handleCallback as stravaCallback,
} from "./strava/routes";
import {
  handleWebhookEvent as stravaWebhookEvent,
  handleWebhookVerify as stravaWebhookVerify,
} from "./strava/webhook";
import { consumeWahooEvent } from "./wahoo/consume";
import {
  handleAuthorize as wahooAuthorize,
  handleCallback as wahooCallback,
} from "./wahoo/routes";
import { handleWebhookEvent as wahooWebhookEvent } from "./wahoo/webhook";

// The runtime resolves the durable_objects binding against the entry point's
// exports.
export { TokenBroker } from "./tokens/broker";

// Both sources budget over nested windows: Wahoo 200 per 5 minutes, 1,000
// per hour and 5,000 per day, Strava 100 per 15 minutes and 1,000 per day.
// Clearing only the shortest window is not enough, because a backlog bigger
// than that window's budget retries fast enough to keep the longer windows
// exhausted and never drains. Each attempt therefore walks out to the next
// window.
const RATE_LIMIT_BACKOFF_S: Record<IngestMessage["source"], number[]> = {
  strava: [15 * 60, 15 * 60, 60 * 60, 6 * 60 * 60],
  wahoo: [5 * 60, 5 * 60, 60 * 60, 6 * 60 * 60],
};
const RETRY_DELAY_S = 60;

// `attempts` counts the delivery in progress, so it starts at 1.
function rateLimitDelayS(
  source: IngestMessage["source"],
  attempts: number,
): number {
  const ladder = RATE_LIMIT_BACKOFF_S[source];
  const step = Math.min(Math.max(attempts, 1), ladder.length);
  return ladder[step - 1]!;
}

function consumeEvent(message: IngestMessage, env: Env): Promise<void> {
  return message.source === "wahoo"
    ? consumeWahooEvent(message, env)
    : consumeStravaEvent(message, env);
}

export interface BatchOptions {
  consume?: (message: IngestMessage, env: Env) => Promise<void>;
}

export async function consumeBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
  options: BatchOptions = {},
): Promise<void> {
  const consume = options.consume ?? consumeEvent;
  const trail: ConsumeLogEntry[] = [];
  // A 429 means the source's whole budget window is spent, so every later
  // message from that source would spend a request only to earn the same
  // 429. Parking them unattempted is what lets the window recover: without
  // it a large backlog keeps its own budget exhausted and never drains.
  const exhausted = new Map<IngestMessage["source"], number>();
  for (const message of batch.messages) {
    const source = message.body.source;
    const parked = exhausted.get(source);
    if (parked !== undefined) {
      message.retry({ delaySeconds: parked });
      trail.push(consumeLogEntry(message.body, "rate-limited"));
      continue;
    }
    try {
      await consume(message.body, env);
      message.ack();
      trail.push(consumeLogEntry(message.body, "ok"));
    } catch (error) {
      if (error instanceof RateLimitedError) {
        const delaySeconds =
          error.retryAfterS ?? rateLimitDelayS(source, message.attempts);
        exhausted.set(source, delaySeconds);
        message.retry({ delaySeconds });
        trail.push(consumeLogEntry(message.body, "rate-limited"));
        continue;
      }
      console.error(
        `failed to consume ${message.body.source} event: ${String(error)}`,
      );
      message.retry({ delaySeconds: RETRY_DELAY_S });
      trail.push(consumeLogEntry(message.body, `error: ${String(error)}`));
    }
  }
  try {
    await appendConsumeLog(env.TOKENS, trail);
  } catch (error) {
    console.warn(`consume log write failed: ${String(error)}`);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/auth/strava") {
      return stravaAuthorize(url, env);
    }
    if (url.pathname === "/auth/strava/callback") {
      return stravaCallback(url, env);
    }
    if (url.pathname === "/webhooks/strava") {
      if (request.method === "GET") {
        return stravaWebhookVerify(url, env);
      }
      if (request.method === "POST") {
        return stravaWebhookEvent(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/auth/wahoo") {
      return wahooAuthorize(url, env);
    }
    if (url.pathname === "/auth/wahoo/callback") {
      return wahooCallback(url, env);
    }
    if (url.pathname === "/webhooks/wahoo") {
      if (request.method === "POST") {
        return wahooWebhookEvent(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/admin/reconcile") {
      if (request.method === "POST") {
        return handleReconcile(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/admin/wahoo-backfill") {
      if (request.method === "POST") {
        return handleWahooBackfill(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/admin/wahoo-probe") {
      if (request.method === "GET") {
        return handleWahooProbe(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/admin/wahoo-ingest") {
      if (request.method === "POST") {
        return handleWahooIngest(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/admin/consume-log") {
      if (request.method === "GET") {
        return handleConsumeLog(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller, env): Promise<void> {
    try {
      const { enqueued, refreshed } = await reconcileStravaActivities(env);
      console.log(
        `Strava reconciliation enqueued ${enqueued} new and ${refreshed} refresh messages`,
      );
    } catch (error) {
      if (error instanceof RateLimitedError) {
        // The next daily run resumes from the same high-water mark, so
        // there's nothing to retry now.
        console.warn("Strava reconciliation rate limited, ending run");
        return;
      }
      throw error;
    }
  },

  async queue(batch, env): Promise<void> {
    await consumeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, IngestMessage>;
