import { tokenBroker } from "../tokens/broker";
import { exchangeCode, oauthConfig } from "./oauth";

// user_read is mandatory (Wahoo 403s without it), offline_data grants
// refresh tokens and webhooks.
export const SCOPES = "user_read workouts_read offline_data";

function redirectUri(url: URL): string {
  return `${url.origin}/auth/wahoo/callback`;
}

export function handleAuthorize(url: URL, env: Env): Response {
  const config = oauthConfig(env);
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri(url),
    scope: SCOPES,
  });
  return Response.redirect(`${config.oauthBase}/authorize?${params}`, 302);
}

export async function handleCallback(
  url: URL,
  env: Env,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const denied = url.searchParams.get("error");
  if (denied) {
    return new Response(`Wahoo authorization failed: ${denied}`, {
      status: 400,
    });
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("missing code", { status: 400 });
  }

  const config = oauthConfig(env);
  let tokens;
  try {
    tokens = await exchangeCode(config, code, redirectUri(url), fetch);
  } catch {
    // Codes are single-use and short-lived, so a reloaded callback URL
    // fails here. Restarting the flow is the fix, so keep it a 4xx.
    return new Response(
      "authorization code exchange failed, restart at /auth/wahoo",
      { status: 400 },
    );
  }

  // This route is reachable by anyone, and Wahoo will happily issue a valid
  // grant for whoever authorizes. Without an identity check a stranger's
  // tokens land in the store, breaking ingest and pulling their workouts
  // into the registry.
  const user = await fetch(`${env.WAHOO_API_BASE}/v1/user`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!user.ok) {
    return new Response(`could not verify the Wahoo account: ${user.status}`, {
      status: 502,
    });
  }
  const { id } = (await user.json()) as { id?: unknown };
  if (id !== Number(env.WAHOO_USER_ID)) {
    return new Response("unauthorized Wahoo user", { status: 403 });
  }

  await tokenBroker(env, "wahoo").store(tokens);
  return new Response("Wahoo connected", { status: 200 });
}
