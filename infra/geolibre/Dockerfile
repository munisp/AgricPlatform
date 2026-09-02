# syntax=docker/dockerfile:1
# GeoLibre web GIS for AgricPlatform.
#
# Builds the browser bundle of opengeos/GeoLibre (Tauri/React/MapLibre/
# DuckDB-WASM) from a PINNED upstream tag and serves it with nginx on :8300.
#
# Pin (verified via GitHub API):
#   tag    v2.8.0
#   commit 477e9cfb4e0cdde0623007bf98b97f6cfb401493
# The remote stage re-verifies the commit after cloning, so a moved tag
# fails the build loudly instead of silently shipping different code.
#
# Build modes:
#   default (GEOLIBRE_SOURCE=remote): clone from GitHub during the build.
#   GEOLIBRE_SOURCE=local: use ./src populated by ./fetch.sh (air-gapped /
#   CI-friendly; the same pin is enforced by fetch.sh).
#
# Caveat (documented in README.md): the upstream prebuild step that compiles
# the JupyterLite notebook runtime needs Python; without it the web bundle
# still builds (the step is best-effort) and the Notebook panel renders its
# "unavailable" fallback. Python is intentionally not installed here.

ARG GEOLIBRE_TAG=v2.8.0
ARG GEOLIBRE_COMMIT=477e9cfb4e0cdde0623007bf98b97f6cfb401493
ARG GEOLIBRE_SOURCE=remote

# ---- source acquisition ---------------------------------------------------
FROM node:22-bookworm-slim AS fetch-remote
ARG GEOLIBRE_TAG
ARG GEOLIBRE_COMMIT
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${GEOLIBRE_TAG}" \
      https://github.com/opengeos/GeoLibre.git /src \
 && echo "GeoLibre ${GEOLIBRE_TAG} resolved to $(git -C /src rev-parse HEAD)" \
 && test "$(git -C /src rev-parse HEAD)" = "${GEOLIBRE_COMMIT}"

FROM node:22-bookworm-slim AS fetch-local
# src/ is created by infra/geolibre/fetch.sh (same pin, verified there).
COPY src /src

FROM fetch-${GEOLIBRE_SOURCE} AS source
RUN test -f /src/package.json && test -d /src/apps/geolibre-desktop

# ---- web bundle build -----------------------------------------------------
FROM node:22-bookworm-slim AS build
COPY --from=source /src /src
WORKDIR /src
# Strict lockfile install; if upstream's lockfile ever drifts this fails
# loudly (use `npm install` locally to diagnose, then report upstream).
RUN npm ci
# Root script builds the geolibre-desktop workspace (Vite web bundle).
RUN npm run build
RUN test -d /src/apps/geolibre-desktop/dist

# ---- runtime --------------------------------------------------------------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/geolibre-desktop/dist /usr/share/nginx/html
EXPOSE 8300
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8300/healthz || exit 1
