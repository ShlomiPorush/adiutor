# syntax=docker/dockerfile:1
# Mikud: API, MCP and (later) the built UI in one bundle. Build context: repository root.

FROM node:24.21.0-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY config config
COPY src src
RUN pnpm run build

# The bundle needs no node_modules. Runs as node on a read-only root file system; nothing is written at
# runtime, since every piece of state lives in PostgreSQL.
FROM node:24.21.0-bookworm-slim
ARG VERSION=dev
ENV NODE_ENV=production \
    MIKUD_VERSION=${VERSION} \
    PORT=8080 \
    MIGRATIONS_DIR=drizzle
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY drizzle ./drizzle
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/server/healthcheck.js"]
CMD ["node", "dist/server/index.js"]
