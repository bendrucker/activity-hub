import { exchangeCode, oauthConfig, writeTokens } from "./oauth";

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
  fetchImpl: typeof fetch = fetch,
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
    tokens = await exchangeCode(config, code, redirectUri(url), fetchImpl);
  } catch {
    // Codes are single-use and short-lived, so a reloaded callback URL
    // fails here. Restarting the flow is the fix, so keep it a 4xx.
    return new Response(
      "authorization code exchange failed, restart at /auth/wahoo",
      { status: 400 },
    );
  }

  await writeTokens(env.TOKENS, tokens);
  return new Response("Wahoo connected", { status: 200 });
}
