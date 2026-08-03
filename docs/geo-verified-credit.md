# Geo-verified credit (wave-geocredit) — SHADOW MODE

Innovation: a **deterministic sixth credit-scoring factor** derived from
geospatial plot verification. It runs alongside the existing five-factor
model (0–1000) in **shadow mode**: scores are computed, persisted and shown
to credit officers, but the live approve/decline path never reads them.

```
┌────────────┐  GET /credit/applications/:id/geo-shadow   ┌─────────────────┐
│  apps/web  │ ─────────────────────────────────────────▶ │  apps/api       │
│ GeoShadow- │  POST /credit/geo-shadow/recompute (admin) │  credit/        │
│ Panel      │ ◀───────────────────────────────────────── │  geo-           │
└────────────┘                                            │  verification   │
                                                          └───────┬─────────┘
              credit.geo_credit_shadow_scores (migration 028) ◀───┘  ONLY persistence target
                                                                  │
        ┌─────────────────────────────────────────────────────────┼─────────────────────────┐
        │ farm plots (farms module)   flood-risk port (geo-intel) │  crop-ml client port    │
        │ existence + ownership,      FLOOD_ML_DRIVER stub|http   │  CROP_ML_DRIVER         │
        │ boundary area, freshness    (fail-closed, docs/flood-ml)│  stub (default) | http  │
        │                                                     POST {CROP_ML_URL}/v1/crop/assess-plot
        ▼
   computeGeoCreditFactor — PURE function (no I/O, no clock; `now` is an input)
```

## Factor methodology

Inputs (per loan application):

1. **Plot existence + ownership** — the applicant's earliest-registered farm
   plot with centroid coordinates (deterministic pick: `createdAt` asc, then
   `id`). Verified means: the plot exists, carries coordinates and belongs
   to the applicant.
2. **Plot area plausibility** — hectares from the stored boundary GeoJSON
   (shoelace on an equirectangular projection; no PostGIS), falling back to
   the declared `sizeHectares`. Plausible band: **0.01–100 ha** (inclusive).
3. **Flood-risk band** — via the geo-intel flood driver port
   (`FLOOD_ML_DRIVER`), severity mapped `none|low|moderate|high|severe`
   (unknown severities map to the neutral `moderate`).
4. **Crop health** — crop-ml sidecar `health_score` (0–100) via the
   `CropIntelClient` port.
5. **Data freshness** — age of the plot record (`updatedAt`).

### Weighting table (max 100)

| Component          | Points | Rule |
|--------------------|-------:|------|
| Plot verification  |     25 | 25 if verified, else 0 (gates every other component) |
| Area plausibility  |     15 | 15 if area ∈ [0.01, 100] ha, else 0 |
| Flood risk         |     20 | none=20, low=16, moderate=10, high=5, severe=0 |
| Crop health        |     30 | round(health_score / 100 × 30), clamped 0–30 |
| Data freshness     |     10 | ≤30d=10, ≤90d=7, ≤180d=4, ≤365d=2, older=0 |

Same inputs → same outputs, always (known-answer vectors in
`geo-credit-factor.spec.ts`). Every input carries an honest basis flag —
`basis.flood: stub|live`, `basis.crop: stub|live|unavailable` — rendered as
visible STUB / LIVE / UNAVAILABLE badges in the officer UI.

## Shadow-mode rationale

Geospatial signals are promising but unproven for this portfolio. Shadow
mode lets us collect factor outputs against real applications **with zero
decision impact** so the model can be validated before anyone's credit
decision depends on it. Hard guarantees, enforced by test:

- Scores persist **only** to `credit.geo_credit_shadow_scores`.
- `CreditService` (score/approve/reject) never imports the geo-verification
  module or the shadow repository — a source-level test asserts this, and a
  functional test asserts the decision output is byte-identical with the
  shadow module enabled vs disabled.
- `GET /credit/applications/:id/geo-shadow` is role-gated to
  admin|lender (credit officers).

## Activation gates — there is NO `live` mode in this wave

`GEO_CREDIT_MODE` accepts only `shadow` (default) and `off`. Promoting the
factor into the live score requires BOTH:

1. **Model validation against ground truth** — shadow scores back-tested
   against repayment outcomes and field-verified plot data over at least one
   full growing season, with documented lift over the 5-factor baseline.
2. **Fair-lending legal review** — geospatial factors can proxy for
   region/ethnicity; a documented disparate-impact analysis and sign-off by
   counsel is required before activation.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEO_CREDIT_MODE` | `shadow` | `shadow` computes + serves shadow scores; `off` disables the endpoints (404). No `live` value exists. |
| `CROP_ML_DRIVER` | `stub` | `stub` = deterministic labelled fixture; `http` = crop-ml sidecar. |
| `CROP_ML_URL` | — | Base URL of the crop-ml sidecar (e.g. `http://localhost:8100`). Required when `CROP_ML_DRIVER=http`. |
| `FLOOD_ML_DRIVER` / `FLOOD_ML_URL` | `stub` / — | Reused from geo-intel; see docs/flood-ml.md. |

The crop-ml sidecar contract (FIXED — sibling wave): `POST
/v1/crop/assess-plot` `{plot_id, geometry?, season?}` → `{plot_id, season,
health_score, phenology{sos,eos,peak}, classification, drivers, basis}`;
`GET /healthz`. The http client uses a 5 s timeout, 2 retries (5xx/network
only), and a circuit breaker (5 consecutive failures open it for 60 s).

## Fail-closed doctrine

When `CROP_ML_DRIVER=http` is configured but the sidecar is missing or
unreachable, the factor records `status: 'unavailable'`,
`basis.crop: 'unavailable'`, **no score**, on-demand reads answer **503**,
and batch recompute counts the application as unavailable. The stub is
**never** silently substituted for a configured live provider — serving a
simulated fixture as if it were live inference would be fabrication. The
flood input follows the same doctrine via the geo-intel port.

## Batch recompute

`POST /credit/geo-shadow/recompute` (admin) recomputes shadow scores for
open applications (`submitted`, `scoring`, `approved`). Idempotent per
application + input fingerprint: unchanged inputs are skipped (no new row),
changed inputs append a new row (unique `(application_id,
input_fingerprint)`), per-application failures never abort the batch.

## Honest limits

- **crop-ml basis may be stub.** Until the sidecar ships and is configured,
  crop health is a deterministic hash-seeded fixture — clearly labelled
  STUB in API output and UI badges.
- **No ground-truth calibration has been done.** The weights above are
  reasoned, not fitted; activation gate #1 exists precisely because they
  are unvalidated.
- Plot area from boundary GeoJSON uses a planar equirectangular
  approximation (~1% error at smallholder scale); declared `sizeHectares`
  is the fallback.
- Only the earliest-registered plot per applicant feeds the factor;
  multi-plot aggregation is future work.
- Flood severity from the flood-ml sidecar is itself an unvalidated model
  estimate (see docs/flood-ml.md); the stub flood driver is a fixture.
