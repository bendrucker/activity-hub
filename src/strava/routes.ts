import { exchangeCode, type OAuthConfig, writeTokens } from "./oauth";

export const SCOPE = "activity:read_all";

export function oauthConfig(env: Env): OAuthConfig {
  return {
    oauthBase: env.STRAVA_OAUTH_BASE,
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
  };
}

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

  const { tokens, athleteId } = await exchangeCode(
    oauthConfig(env),
    code,
    fetchImpl,
  );

  if (athleteId !== Number(env.STRAVA_ATHLETE_ID)) {
    return new Response("unauthorized athlete", { status: 403 });
  }

  await writeTokens(env.TOKENS, tokens);
  return new Response("Strava connected", { status: 200 });
}
