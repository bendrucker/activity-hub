import { RateLimitedError, type IngestMessage } from "./ingest";
import { consumeStravaEvent } from "./strava/consume";
import { handleAuthorize, handleCallback } from "./strava/routes";
import { handleWebhookEvent, handleWebhookVerify } from "./strava/webhook";

// A 429 clears when the 15-minute budget window rolls over, so waiting out
// one full window beats exponential guessing.
const RATE_LIMIT_WINDOW_S = 15 * 60;
const RETRY_DELAY_S = 60;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/auth/strava") {
      return handleAuthorize(url, env);
    }
    if (url.pathname === "/auth/strava/callback") {
      return handleCallback(url, env);
    }
    if (url.pathname === "/webhooks/strava") {
      if (request.method === "GET") {
        return handleWebhookVerify(url, env);
      }
      if (request.method === "POST") {
        return handleWebhookEvent(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }
    return new Response("Not Found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await consumeStravaEvent(message.body, env);
        message.ack();
      } catch (error) {
        if (error instanceof RateLimitedError) {
          message.retry({ delaySeconds: RATE_LIMIT_WINDOW_S });
          continue;
        }
        console.error(`failed to consume Strava event: ${String(error)}`);
        message.retry({ delaySeconds: RETRY_DELAY_S });
      }
    }
  },
} satisfies ExportedHandler<Env, IngestMessage>;
