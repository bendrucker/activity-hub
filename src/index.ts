import { handleAuthorize, handleCallback } from "./strava/routes";
import { handleWebhookEvent, handleWebhookVerify } from "./strava/webhook";

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

  async queue(batch): Promise<void> {
    // Ack everything so nothing dead-letters until real consumers exist.
    for (const message of batch.messages) {
      message.ack();
    }
  },
} satisfies ExportedHandler<Env>;
