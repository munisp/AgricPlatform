# syntax=docker/dockerfile:1
# geo-compute — Rust geospatial batch-compute sidecar.
# Multi-stage: build with the official Rust toolchain, run on distroless.
#
# Build (from the repo root or this directory):
#   docker build -t agricplatform/geo-compute:local services/geo-compute
# Run:
#   docker run --rm -p 8200:8200 -e GEOCOMPUTE_MODE=live agricplatform/geo-compute:local

FROM rust:1.97-slim-bookworm AS build
WORKDIR /app
# Cargo.lock is committed (binary convention): reproducible, --locked build.
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /app/target/release/geo-compute /usr/local/bin/geo-compute
USER nonroot
EXPOSE 8200
# Defaults are the fail-closed development profile; production must set
# GEOCOMPUTE_MODE=live explicitly.
ENV GEOCOMPUTE_MODE=stub \
    GEOCOMPUTE_PORT=8200
ENTRYPOINT ["/usr/local/bin/geo-compute"]
