# AgricPlatform web (Next.js) image — npm workspaces aware.
# Build from the REPOSITORY ROOT:
#   docker build -f infra/docker/web.Dockerfile .
#
# Expects the Next.js app at apps/web with `output: "standalone"` in
# next.config so the runtime stage can run the self-contained server.

# ---- deps: install workspace dependencies with a reproducible lockfile ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace=apps/web --include-workspace-root

# ---- build: compile shared contracts, then the Next.js production build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_KEYCLOAK_URL=http://localhost:8080
ARG NEXT_PUBLIC_KEYCLOAK_REALM=agric-platform
ARG NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=agric-web
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_KEYCLOAK_URL=$NEXT_PUBLIC_KEYCLOAK_URL \
    NEXT_PUBLIC_KEYCLOAK_REALM=$NEXT_PUBLIC_KEYCLOAK_REALM \
    NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=$NEXT_PUBLIC_KEYCLOAK_CLIENT_ID \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace=packages/shared --if-present \
    && npm run build --workspace=apps/web

# ---- runtime: minimal standalone server, non-root ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S agric && adduser -S agric -G agric
# Next.js standalone output embeds the subset of node_modules it needs.
COPY --from=build --chown=agric:agric /app/apps/web/.next/standalone ./
COPY --from=build --chown=agric:agric /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=agric:agric /app/apps/web/public ./apps/web/public
USER agric
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1
CMD ["node", "apps/web/server.js"]
