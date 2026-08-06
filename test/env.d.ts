/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface TestBindings {
  TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
}

// `cloudflare:test` types its env as Cloudflare.Env while a Durable Object
// declares the global Env, and the runtime checks one against the other. The
// two views only stay compatible if both carry the test bindings.
declare namespace Cloudflare {
  interface Env extends TestBindings {}
}

interface Env extends TestBindings {}
