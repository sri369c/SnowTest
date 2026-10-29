# Copyright (c) 2026 Srinivas Chaturvedula

# snowtest — Snowflake-compatible stub server
#
# Multi-stage: TypeScript is compiled in the builder, and the runtime image
# carries only production dependencies plus dist/. The base is Debian slim
# (glibc) because @duckdb/node-api ships prebuilt glibc binaries; musl/Alpine
# would need a toolchain for no benefit here.

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SNOWTEST_HOST=0.0.0.0 \
    SNOWTEST_PORT=8080 \
    SNOWTEST_STAGE_ROOT=/var/lib/snowtest/stages

WORKDIR /app

# Production dependencies only, from the lockfile, cached in its own layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Staged files are written to disk; the unprivileged user must own that path.
RUN mkdir -p "$SNOWTEST_STAGE_ROOT" && chown -R node:node "$SNOWTEST_STAGE_ROOT"

USER node

EXPOSE 8080

# Uses Node's built-in fetch, so the image needs no curl or wget.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.SNOWTEST_PORT || 8080) + '/_snowtest/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
