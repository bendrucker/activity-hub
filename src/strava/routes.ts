import { exchangeCode, oauthConfig, writeTokens } from "./oauth";

export const SCOPE = "activity:read_all";

export function handleAuthorize(url: URL, env: Env): Response {
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${url.origin}/auth/strava/callback`,
    approval_prompt: "auto",
    scope: SCOPE,
  });
  return Response.redirect(`${env.STRAVA_OAUTH_BASE}/authorize?${params}`, 302);
}

export async function handleCallback(
  url: URL,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const denied = url.searchParams.get("error");
  if (denied) {
    return new Response(`Strava authorization failed: ${denied}`, {
      status: 400,
    });
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("missing code", { status: 400 });
  }

  // Strava echoes the granted scopes. The athlete can uncheck private
  // activities, which silently breaks the mirror.
  const scope = url.searchParams.get("scope") ?? "";
  if (!scope.split(",").includes(SCOPE)) {
    return new Response(
      `scope ${SCOPE} not granted; re-authorize with private activities enabled`,
      { status: 400 },
    );
  }

  const config = oauthConfig(env);
  let exchange;
  try {
    exchange = await exchangeCode(config, code, fetchImpl);
  } catch {
    // Codes are single-use and short-lived, so a reloaded callback URL
    // fails here. Restarting the flow is the fix, so keep it a 4xx.
    return new Response(
      "authorization code exchange failed, restart at /auth/strava",
      { status: 400 },
    );
  }

  if (exchange.athleteId !== Number(env.STRAVA_ATHLETE_ID)) {
    return new Response("unauthorized athlete", { status: 403 });
  }

  await writeTokens(env.TOKENS, exchange.tokens);
  return new Response("Strava connected", { status: 200 });
}
