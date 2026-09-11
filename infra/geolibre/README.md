# GeoLibre web GIS (agric-platform)

Containerized [GeoLibre](https://github.com/opengeos/GeoLibre) — an
open-source, browser-first geospatial viewer (React + MapLibre +
DuckDB-WASM; Tauri for the desktop builds, which are out of scope here).

**Pin**: upstream tag `v2.8.0`, commit
`477e9cfb4e0cdde0623007bf98b97f6cfb401493` (verified via the GitHub API;
re-verified at build time inside the Dockerfile — a moved tag fails the
build).

## Run

```bash
docker compose -f infra/docker-compose.yml --profile geolibre up -d --build
# GeoLibre UI: http://localhost:8300   health: http://localhost:8300/healthz
```

The Dockerfile has two source modes (build arg `GEOLIBRE_SOURCE`):

- `remote` (default) — `git clone --depth 1 --branch v2.8.0` during the
  image build, commit verified.
- `local` — air-gapped path: run `./fetch.sh` first (clones the same pin
  into `./src` and verifies the commit), then build with
  `GEOLIBRE_SOURCE=local`.

Upstream also publishes its own image (`ghcr.io/opengeos/geolibre`) and
ships its own Dockerfile (full build incl. a Python sidecar for the
JupyterLite notebook runtime). We deliberately build the **web bundle only**:

- the JupyterLite prebuild requires Python; without it the step is
  best-effort and the web bundle builds fine — the in-app Notebook panel
  shows its unavailable fallback;
- adding Python (~500MB) to a static-file image buys nothing we use.

## Layout

| File          | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `Dockerfile`  | pinned clone -> `npm ci && npm run build` -> nginx on :8300    |
| `nginx.conf`  | SPA fallback, `/healthz`, COOP/COEP headers (required by DuckDB-WASM SharedArrayBuffer), wasm-aware gzip |
| `fetch.sh`    | air-gapped source fetch (same pin)                             |

K8s manifest: `infra/k8s/geolibre/deployment.yaml` (Deployment + Service,
probes on `/healthz`). Observability: nginx access logs to stdout; see the
filelog note in `nginx.conf` and the environments matrix.
