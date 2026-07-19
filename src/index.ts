import { handleAuthorize, handleCallback } from "./strava/routes";

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
    return new Response("Not Found", { status: 404 });
  },

  async queue(batch): Promise<void> {
    // Ack everything so nothing dead-letters until real consumers exist.
    for (const message of batch.messages) {
      message.ack();
    }
  },
} satisfies ExportedHandler<Env>;
