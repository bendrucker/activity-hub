import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";
import { SECRETS } from "./test/secrets";
import { SITE_STUB, SITE_WORKER } from "./test/site";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ...SECRETS },
          workers: [{ name: SITE_WORKER, modules: true, script: SITE_STUB }],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // The container's suite runs under Bun with real DuckDB and S3 clients,
      // neither of which the Workers pool can load. `bun test` in container/
      // owns those files.
      exclude: [...configDefaults.exclude, "container/**"],
    },
  };
});
