import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.REGISTRY, env.TEST_MIGRATIONS);
