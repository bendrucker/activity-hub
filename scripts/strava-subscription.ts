#!/usr/bin/env bun
// Manages the Strava push subscription (create/view/delete) outside the
// worker, since Strava's subscription API needs the client secret directly.
//
// Usage: bun scripts/strava-subscription.ts <create|view|delete> [id]

const API_BASE = "https://www.strava.com/api/v3/push_subscriptions";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function withBody(response: Response): Promise<never> {
  throw new Error(
    `request failed: ${response.status} ${await response.text()}`,
  );
}

async function create(clientId: string, clientSecret: string): Promise<void> {
  const verifyToken = requireEnv("STRAVA_VERIFY_TOKEN");
  const callbackUrl =
    process.env.STRAVA_CALLBACK_URL ??
    "https://activity-hub-ingest.bvdrucker.workers.dev/webhooks/strava";

  const response = await fetch(API_BASE, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: callbackUrl,
      verify_token: verifyToken,
    }),
  });
  if (!response.ok) {
    await withBody(response);
  }
  console.log(await response.text());
}

async function view(clientId: string, clientSecret: string): Promise<void> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(`${API_BASE}?${params}`);
  if (!response.ok) {
    await withBody(response);
  }
  console.log(await response.text());
}

async function remove(
  clientId: string,
  clientSecret: string,
  id: string | undefined,
): Promise<void> {
  if (!id) {
    throw new Error("delete requires a subscription id argument");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(`${API_BASE}/${id}?${params}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    await withBody(response);
  }
  console.log(`deleted subscription ${id}: ${response.status}`);
}

async function main(): Promise<void> {
  const [command, id] = process.argv.slice(2);
  const clientId = process.env.STRAVA_CLIENT_ID ?? "12215";
  const clientSecret = requireEnv("STRAVA_CLIENT_SECRET");

  switch (command) {
    case "create":
      return create(clientId, clientSecret);
    case "view":
      return view(clientId, clientSecret);
    case "delete":
      return remove(clientId, clientSecret, id);
    default:
      throw new Error(
        `usage: bun scripts/strava-subscription.ts <create|view|delete> [id]`,
      );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
