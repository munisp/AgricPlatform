# AgricPlatform API (NestJS) image — npm workspaces aware.
# Build from the REPOSITORY ROOT:
#   docker build -f infra/docker/api.Dockerfile .

# ---- deps: install workspace dependencies with a reproducible lockfile ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace=apps/api --include-workspace-root

# ---- build: compile shared contracts, then the NestJS production bundle ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN npm run build --workspace=packages/shared --if-present \
    && npm run build --workspace=apps/api \
    && npm prune --omit=dev

# ---- runtime: production deps only, non-root ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001
RUN addgroup -S agric && adduser -S agric -G agric
COPY --from=build --chown=agric:agric /app/node_modules ./node_modules
COPY --from=build --chown=agric:agric /app/packages/shared ./packages/shared
COPY --from=build --chown=agric:agric /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=agric:agric /app/apps/api/dist ./apps/api/dist
USER agric
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 || exit 1
CMD ["node", "apps/api/dist/main.js"]
