#!/usr/bin/env bash
# fetch.sh — populate ./src with the PINNED GeoLibre upstream source so the
# image can be built without network access at build time:
#
#   infra/geolibre/fetch.sh
#   GEOLIBRE_SOURCE=local docker compose -f infra/docker-compose.yml \
#     --profile geolibre build geolibre
#
# The pin matches infra/geolibre/Dockerfile (tag + commit, both verified).
set -euo pipefail

TAG="v2.8.0"
COMMIT="477e9cfb4e0cdde0623007bf98b97f6cfb401493"
REPO="https://github.com/opengeos/GeoLibre.git"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -rf "${DIR}/src"
git clone --depth 1 --branch "${TAG}" "${REPO}" "${DIR}/src"

HEAD="$(git -C "${DIR}/src" rev-parse HEAD)"
if [ "${HEAD}" != "${COMMIT}" ]; then
    echo "ERROR: pin mismatch: ${TAG} resolved to ${HEAD}, expected ${COMMIT}" >&2
    rm -rf "${DIR}/src"
    exit 1
fi

echo "GeoLibre ${TAG} (${COMMIT}) fetched into ${DIR}/src"
echo "Build with: GEOLIBRE_SOURCE=local docker compose -f infra/docker-compose.yml --profile geolibre build geolibre"
