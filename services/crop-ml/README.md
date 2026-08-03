# crop-ml — crop-intelligence sidecar

Python (FastAPI) sidecar that turns **Sentinel-2-class per-plot band
statistics** into NDVI time series, phenology metrics (SOS/EOS/peak), season
classification, and a 0–100 plot health score with named drivers. It is the
crop-health counterpart to the flood-ml sidecar and follows the same
fail-closed doctrine (`docs/flood-ml.md`).

## Architecture

```
┌────────────┐   POST /v1/crop/assess-plot {plot_id, season}   ┌──────────────────────┐
│  apps/api  │ ───────────────────────────────────────────────▶│  services/crop-ml    │
│  (NestJS)  │◀────────────── seasonality + health score ──────│  FastAPI + scipy     │
└────────────┘                                                 └──────────┬───────────┘
                                                                          │ ImageryProvider port
                                                 ┌────────────────────────┴─────────────────────┐
                                                 │ IMAGERY_PROVIDER=stub (default)              │
                                                 │  deterministic synthetic logistic NDVI curve │
                                                 ├──────────────────────────────────────────────┤
                                                 │ IMAGERY_PROVIDER=live                        │
                                                 │  POST {SENTINEL_STATS_URL}/v1/plot-stats     │
                                                 │  5 s timeout, 2 retries, circuit breaker     │
                                                 │  (5 consecutive failures → open 60 s)        │
                                                 └──────────────────────────────────────────────┘
```

### Why band statistics instead of raw rasters

Two reasons, one honest constraint and one design choice:

- **Constraint:** this service is built to run without rasterio/GDAL. GDAL is
  a heavy system dependency and is not available in every target
  environment, so the service never opens a raster file.
- **Design:** even where GDAL is available, pulling per-plot zonal
  statistics from a dedicated upstream (Sentinel Hub Statistical API, or a
  COG-stats microservice that does the raster I/O once) is the cheaper
  production design: this sidecar stays CPU-light, stateless, and scales
  without image caches. The port (`app/providers/base.py`) keeps the
  upstream swappable.

The API surface also accepts caller-supplied band statistics directly
(`/v1/crop/seasonality`, `/v1/crop/health-score`), so any other statistics
source can drive the same analytics.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/healthz` | — | `{"status": "ok", "version"}` |
| GET | `/readyz` | — | readiness + provider mode + circuit state |
| POST | `/v1/crop/seasonality` | `{plot_id, series: [{date, red, nir}, ...≥6], reference?: [...]}` | NDVI series, phenology (SOS/EOS/peak date & value, amplitude), season classification (`normal`/`delayed`/`stressed`) with reason codes |
| POST | `/v1/crop/health-score` | `{plot_id, current: [...≥6], baseline: [...≥6]}` | 0–100 score + drivers derived from computed deltas (`peak_ndvi_deficit`, `mean_ndvi_deficit`, `late_sos`, `early_eos`, `low_absolute_peak`) |
| POST | `/v1/crop/assess-plot` | `{plot_id, geometry?, season: "YYYY" \| "YYYY-wet" \| "YYYY-dry"}` | Fetches the series from the configured provider, then runs seasonality + health score against the canonical seasonal baseline. Integration endpoint for the NestJS API. |

Errors: invalid input → `422`; provider failure in live mode → `503` with a
machine-readable body `{"detail": {"code": "...", "message": "..."}}`
(`IMAGERY_PROVIDER_UNAVAILABLE`, `IMAGERY_CIRCUIT_OPEN`,
`IMAGERY_MISCONFIGURED`).

## Analytics

- **NDVI** = (NIR − RED) / (NIR + RED), guarded against zero denominators,
  rounded to 6 dp.
- **Phenology** (`app/phenology.py`): Savitzky–Golay smoothing (fixed
  window = largest odd ≤ min(11, n), polyorder 2), interpolated to a daily
  grid; SOS = first crossing of base + 20 % amplitude, EOS = last crossing
  (TIMESAT-style amplitude method). Series shorter than 6 acquisitions are
  rejected with 422.
- **Classification** (`app/anomaly.py`): `stressed` when peak NDVI < 0.30,
  or peak/mean deficit vs the reference exceeds 0.15/0.10; `delayed` when
  SOS is > 14 day-of-year days later than the reference; else `normal`.
- **Health score**: starts at 100 and subtracts capped, driver-attributed
  penalties computed from current-vs-baseline deltas (peak deficit ≤ 40,
  mean deficit ≤ 15, late SOS ≤ 20, early EOS ≤ 15, low absolute peak
  ≤ 25). Drivers are sorted by impact; every subtracted point is named.

**Determinism:** all randomness is seeded (SHA-256-derived seed per
`plot_id|season` — deliberately *not* Python's salted builtin `hash()`, so
results are stable across processes); smoothing parameters are fixed; same
input produces byte-identical responses (covered by tests).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `IMAGERY_PROVIDER` | `stub` | `stub` or `live` |
| `SENTINEL_STATS_URL` | — | Required in live mode. Base URL of the band-statistics API. |
| `SENTINEL_STATS_TOKEN` | — | Required in live mode. Bearer token. |
| `SENTINEL_STATS_TIMEOUT_SECONDS` | `5` | Per-attempt HTTP timeout |
| `SENTINEL_STATS_RETRIES` | `2` | Retries after the first attempt (transport errors + 5xx) |
| `SENTINEL_STATS_CIRCUIT_THRESHOLD` | `5` | Consecutive failures before the breaker opens |
| `SENTINEL_STATS_CIRCUIT_OPEN_SECONDS` | `60` | Fail-fast cooldown while the breaker is open |
| `PORT` | `8100` | Listen port for `python -m app.main` |

### Stub vs live semantics (fail-closed)

- **stub (default):** deterministic synthetic logistic NDVI curve per
  `plot_id|season`, clearly labelled (`provider: "stub"` in responses).
  Development/CI fixture only.
- **live:** calls the configured statistics API. If the upstream is
  unreachable or the circuit is open, `/v1/crop/assess-plot` answers
  **503** — it never silently substitutes stub data. If live mode is
  selected without `SENTINEL_STATS_URL`/`SENTINEL_STATS_TOKEN`, startup
  **raises** (fail-closed); `/readyz` reports `misconfigured`.

## Verification evidence

Run from `services/crop-ml/` on Python 3.12 with the preinstalled packages
in `requirements.txt` (nothing else needs installing):

```bash
python3 -m unittest discover -s tests -v
# Ran 57 tests in ~0.12s — OK (exit code 0)

python3 -m py_compile $(find app tests -name '*.py')            # exit 0
python3 -c "import ast,sys; [ast.parse(open(f).read()) for f in sys.argv[1:]]" \
  $(find app tests -name '*.py')                                # exit 0
```

Test coverage includes: NDVI math vs hand-computed values, savgol edge
handling and <6-acquisition rejection (422), phenology on a synthetic
logistic curve with SOS in a known window, health-score monotonicity,
injected mid-season stress lowering the score with `peak_ndvi_deficit` as
the top driver, stub determinism (byte-identical repeats), live-mode
fail-closed 503 (httpx mocked), circuit-breaker open/fail-fast/recovery,
live-mode-missing-config startup failure, and API contract tests via
`fastapi.testclient.TestClient`.

A live smoke run (`uvicorn app.main:app --port 8100`) was verified:
`/healthz` → `{"status":"ok"}`, `/readyz` → stub/ready, assess-plot → 200
with a 45-acquisition series, 1-sample series → 422.

### Docker

```bash
docker build -t agricplatform/crop-ml:local services/crop-ml
docker run --rm -p 8100:8100 agricplatform/crop-ml:local
```

## Honest limitations — NOT verified

- **Docker build was not executed** in the authoring sandbox (no docker
  daemon). The Dockerfile is minimal (slim image, pip install, non-root
  user) but is not build-verified.
- **Live provider never tested against a real statistics API** (no Sentinel
  Hub credentials / no network). The upstream contract
  (`POST /v1/plot-stats` → `{"series": [...]}`) is defined by this service
  and mocked in tests; a real integration needs a matching adapter.
- **No agronomic ground-truth validation.** Classification and scoring
  thresholds (peak floor 0.30, deficit thresholds 0.15/0.10, delay
  threshold 14 days, penalty caps) are literature-typical defaults and
  **require local calibration** before agronomic decisions are based on
  them.
- Stub data is a simulation fixture. Consumers must check the `provider`
  field before treating an assessment as satellite-derived.
