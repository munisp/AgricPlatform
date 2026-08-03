# Flood-risk ML integration (wave ML)

Satellite flood-detection for farmer plots, integrated as an **OPTIONAL,
disabled-by-default sidecar**. The platform boots, serves the advisory page
and passes every gate without it.

## Architecture

```
┌────────────┐   GET /geo-intel/flood-risk[?lat&long]   ┌──────────────────┐
│  apps/web  │ ───────────────────────────────────────▶ │  apps/api        │
│ FloodRisk- │   GET /geo-intel/flood-risk/status       │  geo-intel       │
│ card       │ ◀─────────────────────────────────────── │  module          │
└────────────┘                                         └───────┬──────────┘
                                                               │ FloodRiskDriver port
                                        ┌──────────────────────┴─────────────────────┐
                                        │ FLOOD_ML_DRIVER=stub (default)             │
                                        │ StubFloodRiskDriver — deterministic,        │
                                        │ clearly-labelled SIMULATED fixture.         │
                                        ├─────────────────────────────────────────────┤
                                        │ FLOOD_ML_DRIVER=http + FLOOD_ML_URL         │
                                        │ HttpFloodRiskDriver — POST {URL}/predict    │
                                        ▼                                             │
                              ┌──────────────────┐                                    │
                              │ services/flood-ml│  OPTIONAL sidecar (compose         │
                              │ FastAPI + IBM    │  profile `flood-ml`). IBM Granite  │
                              │ Granite geospatial│ geospatial-uki-flooddetection     │
                              │ flood detection  │  over Sentinel-1 SAR + Sentinel-2. │
                              └──────────────────┘
```

- **Sidecar** (`services/flood-ml/`): ported from
  `munisp/farmer-data-collection` `ml-service/`. Wraps the IBM Granite
  geospatial flood-detection model (`ibm-granite/granite-geospatial-uki-flooddetection`,
  Hugging Face) behind FastAPI. Endpoints: `GET /healthz`, `POST /predict`
  (plus the upstream `/api/flood-detection` routes). Real inference needs
  Sentinel Hub credentials; see `services/flood-ml/README.md`.
- **API module** (`apps/api/src/modules/geo-intel/`): `FloodRiskService`
  behind a driver port, mirroring the weather-driver convention
  (`integrations/drivers/weather.drivers.ts`). The **stub driver is the
  default** and returns a deterministic, explicitly-labelled simulated
  fixture — it is never presented as a live satellite assessment. The
  **http driver** calls the sidecar with a 5 s timeout and a simple circuit
  breaker (opens after 3 consecutive failures for 30 s, checked at call
  time — no in-process timers).
- **Fail-closed**: when `FLOOD_ML_DRIVER=http` but `FLOOD_ML_URL` is missing
  or the sidecar is unreachable, assessments answer **503
  ServiceUnavailable** rather than silently serving simulated data.
- **Authz & scoping**: both endpoints require an authenticated identity.
  Without `lat`/`long` the API resolves the caller's own farm plots (farms
  module) and assesses the plot centroid; with explicit coordinates it
  assesses the point and attaches the caller's nearest own plot when within
  50 km. Every assessment writes an audit record
  (`geo_intel.flood_risk_assessed`) and publishes the domain event
  `geo_intel.flood_risk.assessed`.
- **Web card** (`apps/web/components/flood-risk-card.tsx` on the advisory
  page): reads the status endpoint first and renders honest states — demo
  fixture (badged "demo data"), live model estimate (badged, with NiMet
  caveat), or a "not set up" empty state. English-only strings, union-appended
  to the `en` dictionary under `floodRisk.*`.

## Enabling locally

```bash
# 1. Start the sidecar (Sentinel Hub credentials required for real inference)
export SENTINEL_HUB_CLIENT_ID=... SENTINEL_HUB_CLIENT_SECRET=...
docker compose -f infra/docker-compose.yml --profile flood-ml up -d flood-ml
curl -s localhost:8001/healthz

# 2. Point the API at it and restart the API
export FLOOD_ML_DRIVER=http FLOOD_ML_URL=http://localhost:8001

# 3. Check the honest status and an assessment
curl -s -H "x-user-id: <dev-user>" localhost:3001/api/v1/geo-intel/flood-risk/status
curl -s -H "x-user-id: <dev-user>" "localhost:3001/api/v1/geo-intel/flood-risk?lat=9.08&long=8.68"
```

Without Sentinel Hub credentials the sidecar still starts, but `/predict`
answers 503 and the status endpoint says so honestly. A seeded mock route
(`GET /api/flood-detection/mock`) exists on the sidecar for plumbing tests
only — the platform never calls it.

## Production notes

- **Placement**: run flood-ml as a separate service/node. CPU inference of a
  transformer segmentation model takes tens of seconds per tile; a **GPU
  node is strongly recommended** for anything beyond occasional checks.
  First inference downloads model weights from Hugging Face — pre-warm the
  image or mount a model cache.
- **Sentinel Hub quota**: the free tier is small (~30k processing
  units/month); each assessment consumes Sentinel-1 + Sentinel-2 tiles for a
  5 km box. Budget quota and keep the sidecar's 1-hour Redis result cache
  enabled. Treat the API-side circuit breaker as protection, not quota
  management.
- **Secrets**: `SENTINEL_HUB_CLIENT_ID`/`SENTINEL_HUB_CLIENT_SECRET` come
  from the environment only; nothing is committed.
- **Caching**: the sidecar caches per coordinate+date for 1 h in Redis
  (optional). The API deliberately does not add a second cache layer yet.

## Honest limitations

- **Accuracy unverified by us.** The Granite UKI flood-detection model was
  not trained on Nigerian smallholder plots; we have run no ground-truth
  validation. Treat output as an unverified model estimate.
- **Not a substitute for NiMet advisories** or on-the-ground reports — the
  web card says this to users on every render.
- Cloud cover limits Sentinel-2 optical input; the SAR path mitigates but
  does not eliminate gaps.
- The stub driver (default) is a **simulation fixture** for development and
  CI. Any UI, API consumer or report must check `driver`/`liveInference`
  before treating an assessment as model output.
