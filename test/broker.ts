import { env, runInDurableObject } from "cloudflare:test";
import { TOKENS_KEY as STRAVA_TOKENS_KEY } from "../src/strava/oauth";
import type { BrokerOptions, TokenBroker } from "../src/tokens/broker";
import type { Provider, TokenSource } from "../src/tokens/source";
import { TOKENS_KEY as WAHOO_TOKENS_KEY } from "../src/wahoo/oauth";

const KV_KEYS: Record<Provider, string> = {
  wahoo: WAHOO_TOKENS_KEY,
  strava: STRAVA_TOKENS_KEY,
};

export function brokerStub(provider: Provider): DurableObjectStub<TokenBroker> {
  return env.TOKEN_BROKER.get(env.TOKEN_BROKER.idFromName(provider));
}

// runInDurableObject cannot infer the class from the stub, so every caller
// would otherwise name both type arguments.
export function withBroker<R>(
  provider: Provider,
  run: (broker: TokenBroker, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
  return runInDurableObject<TokenBroker, R>(brokerStub(provider), run);
}

// Both stores, because an empty broker adopts whatever KV still holds.
export async function clearTokens(provider: Provider): Promise<void> {
  await env.TOKENS.delete(KV_KEYS[provider]);
  await withBroker(provider, (_broker, state) => state.storage.deleteAll());
}

// The production adapter reaches the broker over RPC, which cannot carry a
// fetch stub. Tests that drive a refresh hold the instance itself instead.
export function brokerSource(broker: TokenBroker, options: BrokerOptions = {}): TokenSource {
  return {
    accessToken: () => broker.accessToken(options),
    refresh: (used) => broker.refresh(used, options),
    current: () => broker.current(),
    store: (tokens) => broker.store(tokens),
  };
}
