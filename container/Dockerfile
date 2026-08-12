# Built with the repository root as context: the server imports the telemetry
# decoders out of src/import, which sits above this directory.
#
# Debian rather than Alpine, because @duckdb/node-bindings publishes prebuilt
# glibc addons and no musl build. amd64 because that is what Cloudflare
# containers run, and the prebuilt addon is chosen at install time.
FROM --platform=linux/amd64 oven/bun:1.3.14-slim AS dependencies
WORKDIR /app
COPY container/package.json container/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM --platform=linux/amd64 oven/bun:1.3.14-slim
WORKDIR /app

# Module resolution walks up from both container/ and src/import/, so the
# installed packages belong at the app root rather than beside either one.
COPY --from=dependencies /app/node_modules ./node_modules

COPY container/decode.ts \
  container/env.ts \
  container/index.ts \
  container/parquet.ts \
  container/schema.ts \
  container/server.ts \
  container/storage.ts \
  ./container/
COPY src/import/fit.ts src/import/gpx.ts src/import/telemetry.ts ./src/import/
COPY src/transform/protocol.ts ./src/transform/

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "container/index.ts"]
