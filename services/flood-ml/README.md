# flood-ml — IBM Granite geospatial flood-detection sidecar

**OPTIONAL.** AgricPlatform boots and passes all gates without this service.
It is a disabled-by-default sidecar that the API only calls when you opt in
with `FLOOD_ML_DRIVER=http` (see `docs/flood-ml.md`).

Ported faithfully from `munisp/farmer-data-collection` (`ml-service/`) for
AgricPlatform wave ML. Changes made during the port:

- Added `/healthz` (liveness alias of `/health`) and `/predict` (canonical
  alias of `POST /api/flood-detection`) — the platform API targets these.
- Removed the upstream `/predict/yield` and `/predict/price` endpoints: they
  returned **random** numbers, not model output. Nothing in AgricPlatform may
  present fabricated inference as real.
- Made model loading **fail-closed**: if the Hugging Face weights cannot be
  loaded, construction raises and inference requests get `503` — the upstream
  "print a warning, then serve a deterministic RNG mask" fallback
  (`_mock_prediction`) is deleted from the request path entirely.
- Labelled every response with provenance: real inference returns
  `basis: "live"`, the mock endpoint returns `basis: "mock"`, and the mock
  endpoint is refused (`404`) when `FLOOD_ML_ENV=production`.
- Fixed error mapping: deliberate 503/400 responses are no longer re-raised
  as 500, 500 bodies no longer leak internal exception text, and a missing
  upstream Sentinel observation maps to 503 (not 400).
- `/health`/`/healthz` now derive `status` from the actual capability flags
  (including whether model weights really loaded) instead of always
  reporting `"healthy"`.
- Fixed the Docker `HEALTHCHECK` (used the `requests` package, which is not
  in `requirements.txt`; now uses stdlib `urllib`).
- Replaced global `np.random.seed(...)` in the mock endpoint with a local
  `np.random.default_rng(seed)` so it cannot corrupt other RNG consumers.

Everything else — model wrapper, Sentinel Hub preprocessing, Redis result
caching, the seeded `/api/flood-detection/mock` endpoint — is upstream code.

## What the model is

`models/flood_detection.py` wraps
[`ibm-granite/granite-geospatial-uki-flooddetection`](https://huggingface.co/ibm-granite/granite-geospatial-uki-flooddetection),
IBM's Granite geospatial flood-detection model, loaded from Hugging Face via
`transformers.AutoModelForImageSegmentation`. Given a bounding box it fuses
Sentinel-2 optical and Sentinel-1 SAR imagery and returns a flood mask plus
statistics (flooded %, area km², mean confidence) and a severity label.

**The model weights are downloaded from Hugging Face on first inference** —
first `/predict` call is slow and needs outbound network access (or a
pre-warmed image/host cache).

## What it needs

| Variable | Required | Purpose |
| --- | --- | --- |
| `SENTINEL_HUB_CLIENT_ID` | **yes, for real inference** | Sentinel Hub OAuth client id |
| `SENTINEL_HUB_CLIENT_SECRET` | **yes, for real inference** | Sentinel Hub OAuth client secret |
| `SENTINEL_HUB_INSTANCE_ID` | optional | Sentinel Hub configuration instance |
| `REDIS_HOST` / `REDIS_PORT` | optional | result cache (1 h TTL); runs fine without Redis |
| `FLOOD_ML_ENV` | optional | set to `production` to disable the mock endpoint (404) |

Without Sentinel Hub credentials every real-inference call returns
`503 Sentinel Hub credentials not configured`; if the model weights cannot
be downloaded from Hugging Face, inference returns
`503 Flood detection model unavailable` — the service never substitutes
fabricated output for a failed model. The seeded
`GET /api/flood-detection/mock` endpoint works without credentials and
returns `basis: "mock"` (real inference returns `basis: "live"`) — use it
only for plumbing tests, never in product UI.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /healthz` | liveness: `status` derived from model weights loaded, Sentinel Hub configured, Redis available |
| `POST /predict` | flood inference for `{latitude, longitude, bbox_size_km?, date?, days_back?}` (`basis: "live"`) |
| `POST /api/flood-detection` | upstream route, same behaviour as `/predict` |
| `GET /api/flood-detection/mock` | seeded mock response for plumbing tests (`basis: "mock"`; 404 when `FLOOD_ML_ENV=production`) |
| `GET /health`, `GET /` | upstream health/root |

## Run it

```bash
# Docker (recommended — GDAL/torch toolchain is heavy)
docker build -t agric-flood-ml services/flood-ml
docker run --rm -p 8001:8001 \
  -e SENTINEL_HUB_CLIENT_ID=... -e SENTINEL_HUB_CLIENT_SECRET=... \
  agric-flood-ml

# Or via the compose profile (from the repo root)
docker compose -f infra/docker-compose.yml --profile flood-ml up -d flood-ml

# Local virtualenv
cd services/flood-ml
python3.11 -m venv venv && source venv/bin/activate
pip install -r requirements.txt   # needs system GDAL (see Dockerfile)
uvicorn app:app --host 0.0.0.0 --port 8001
```

## Verification

The upstream repo shipped no test suite; AgricPlatform adds a stdlib
`unittest` suite (`tests/`) covering the fail-closed contract — model-load
failure → 503 with no mask, mock labelling and the production guard, 503
vs 500 mapping, and health-status derivation. It runs without the heavy ML
stack (torch/transformers/redis are not required):

```bash
cd services/flood-ml
python3 -m unittest discover -s tests -v
```

Manual verification:

```bash
curl -s localhost:8001/healthz
# {"status":"degraded","models_loaded":false,"model_weights_loaded":false,"sentinel_hub_configured":true|false,...}
# ("healthy" only once model weights are loaded, Sentinel Hub is configured
#  and Redis is reachable; "unhealthy" if the model code cannot even load)

# Plumbing check without credentials (mock, seeded by coordinates):
curl -s "localhost:8001/api/flood-detection/mock?latitude=9.08&longitude=8.68"

# Real inference (requires Sentinel Hub credentials; first call downloads
# the model weights and can take minutes on CPU):
curl -s -X POST localhost:8001/predict \
  -H 'content-type: application/json' \
  -d '{"latitude": 9.08, "longitude": 8.68, "bbox_size_km": 5}'
```

## Honest limitations

- Model accuracy on Nigerian smallholder plots is **unverified by us**; the
  UKI flood-detection model was not trained for this geography.
- Output is a decision-support signal only — **not** a substitute for NiMet
  advisories or on-the-ground reports.
- CPU inference is slow (tens of seconds per tile); a GPU node is
  recommended for production. See `docs/flood-ml.md` for production notes.
