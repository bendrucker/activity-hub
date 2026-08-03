import { handleReconcile, handleWahooBackfill } from "./admin";
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

// A 429 clears when the 15-minute budget window rolls over, so waiting out
// one full window beats exponential guessing.
const RATE_LIMIT_WINDOW_S = 15 * 60;
const RETRY_DELAY_S = 60;

function consumeEvent(message: IngestMessage, env: Env): Promise<void> {
  return message.source === "wahoo"
    ? consumeWahooEvent(message, env)
    : consumeStravaEvent(message, env);
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
    for (const message of batch.messages) {
      try {
        await consumeEvent(message.body, env);
        message.ack();
      } catch (error) {
        if (error instanceof RateLimitedError) {
          message.retry({ delaySeconds: RATE_LIMIT_WINDOW_S });
          continue;
        }
        console.error(
          `failed to consume ${message.body.source} event: ${String(error)}`,
        );
        message.retry({ delaySeconds: RETRY_DELAY_S });
      }
    }
  },
} satisfies ExportedHandler<Env, IngestMessage>;
