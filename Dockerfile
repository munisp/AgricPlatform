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

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0
RUN addgroup -S agric && adduser -S agric -G agric
COPY --from=build --chown=agric:agric /app ./
USER agric
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 \
    && wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1
CMD ["npm", "run", "start"]
