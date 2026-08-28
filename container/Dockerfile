# Built with the repository root as context: the server imports the telemetry
# decoders out of src/import, which sits above this directory.
#
# Debian rather than Alpine, because @duckdb/node-bindings publishes prebuilt
# glibc addons and no musl build. amd64 because that is what Cloudflare
# containers run, and the prebuilt addon is chosen at install time.
FROM --platform=linux/amd64 oven/bun:1.4.0-slim AS dependencies
WORKDIR /app
COPY container/package.json container/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM --platform=linux/amd64 oven/bun:1.4.0-slim
WORKDIR /app

# The slim image ships no CA bundle. Bun's own fetch carries its roots, so the
# S3 writes work without one, but DuckDB's httpfs verifies through the system
# store and fails every read out of R2 without this.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Module resolution walks up from both container/ and src/import/, so the
# installed packages belong at the app root rather than beside either one.
COPY --from=dependencies /app/node_modules ./node_modules

# Every module under container/, less the tests and dev scripts .dockerignore
# keeps out of the context. Naming each file drifted twice: a new module lands,
# the image ships without it, and the container exits on the missing import
# before it ever listens.
COPY container/*.ts ./container/
COPY src/import/fit.ts src/import/gpx.ts src/import/telemetry.ts ./src/import/
COPY src/transform/protocol.ts ./src/transform/

# httpfs is what lets DuckDB read the decode artifacts straight out of R2.
# Baking it in means a running container never reaches the extension
# repository, which would otherwise sit in the path of every lake build. It
# lands under HOME, which is the same for this layer and the running process.
RUN bun --eval "const {DuckDBInstance} = await import('@duckdb/node-api'); \
  const c = await (await DuckDBInstance.create(':memory:')).connect(); \
  await c.run('INSTALL httpfs'); await c.run('LOAD httpfs');"

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "container/index.ts"]
