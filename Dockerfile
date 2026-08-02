# AgricPlatform all-in-one image for platform preview and environment validation.
# Production deployments should prefer the separate service images in infra/docker/.
# Build from the repository root:
#   docker build -t agric-platform .

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Strip devDependencies so the runtime stage copies megabytes, not gigabytes —
# the previous runtime copied the full workspace (all of node_modules incl.
# build tooling), which made the image heavy enough to fail constrained
# preview builders.
FROM build AS prune
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0
RUN addgroup -S agric && adduser -S agric -G agric
# API: compiled output + production deps only.
COPY --from=prune --chown=agric:agric /app/node_modules ./node_modules
COPY --from=build --chown=agric:agric /app/apps/api/dist ./apps/api/dist
# Web: Next standalone output is self-contained (its own minimal node_modules).
COPY --from=build --chown=agric:agric /app/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=build --chown=agric:agric /app/apps/web/.next/static ./apps/web/.next/standalone/apps/web/.next/static
COPY --from=build --chown=agric:agric /app/apps/web/public ./apps/web/.next/standalone/a