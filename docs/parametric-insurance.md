# Parametric insurance rail (wave-insurance)

Plot-level parametric insurance for smallholders: deterministic trigger
evaluation against weather/flood observations, graduated payouts, and a
stub-execution payout rail that settles through the existing double-entry
ledger. Everything here is **safe to demo end-to-end with zero external
dependencies** — and every surface honestly labels simulated inputs.

## What is real vs. simulated

| Piece | Status |
| --- | --- |
| Product catalog, policy lifecycle, premium rate card | Real (deterministic) |
| Trigger evaluation engine | Real (pure functions, byte-stable) |
| Weather observations | **STUB by default** — hash-seeded series per h3 cell + season, `basis:'stub'`. LIVE via `WEATHER_API_URL` + `WEATHER_API_KEY` (external contract below) |
| Flood assessments | Reuses the geo-intel flood-risk port (stub default, flood-ml sidecar optional) |
| Payout execution | **STUB** — ledger entries only (`execution:'stub'`). No money moves |
| Real disbursement | **Externally gated** — insurer MOU + payment rail activation (below) |

## Trigger math

A product trigger is `{ metric, operator, threshold, h3Resolution,
observationWindowDays, season }`:

- `rainfall_mm` — total rainfall over the window (WeatherProvider daily
  series, summed to one decimal). Fires when `total <= threshold`
  (operator `lte`).
- `heat_days` — count of days with daily maximum `>= 38 °C` in the window
  (WeatherProvider). Fires when `count >= threshold` (operator `gte`).
- `flood_rank` — geo-intel flood severity mapped to a rank
  (none=0 … severe=4). Fires when `rank >= threshold` (operator `gte`).

**Breach ratio** measures severity past the threshold:

- `lte`: `ratio = (threshold - observed) / threshold`
- `gte`: `ratio = (observed - threshold) / threshold`

Exactly at the threshold the breach **fires with ratio 0** — an
at-threshold breach is still a breach. The graduated payout table maps
ratio bands to a percent of the sum insured; bands match from the highest
`minRatio` down, so ratio 0 pays the lowest band. Every catalog product
carries a `minRatio: 0` band.

Payout: `payoutKobo = round(sumInsuredKobo × payoutPercent / 100)`.

## Premium rate card

Deterministic integer kobo arithmetic (mirrored client-side by the web
quote calculator):

```
premiumKobo = round_half_up(sumInsuredKobo × premiumRateBps × floodModifierBps / 10^8)
```

- Base peril rates: RAINFALL_DEFICIT 800 bps, FLOOD 1000 bps,
  HEAT_STRESS 600 bps of the sum insured.
- Flood-band modifiers (geo-intel assessment at quote time):
  none 1.00×, low 1.05×, moderate 1.125×, high 1.25×, severe 1.50×.
- Sum insured bounds: ₦1,000 – ₦1,000,000 (100_000 – 100_000_000 kobo).

## Evidence model

Every `TriggerEvent` carries an evidence payload sufficient to reproduce
the evaluation without trusting the evaluator:

```json
{
  "h3Cell": "8741e68dfffffff",
  "h3Resolution": 7,
  "season": "2026-wet",
  "windowDays": 30,
  "metric": "rainfall_mm",
  "observedValue": 32.5,
  "dailyValues": [1.1, 0.0],
  "threshold": 40,
  "operator": "lte",
  "breachRatio": 0.1875,
  "basis": { "weather": "stub", "flood": "unavailable" },
  "evaluatedAt": "2026-08-01T00:00:00.000Z"
}
```

`basis` flags are honest provenance labels: `stub` (simulated fixture),
`live` (external provider), `unavailable` (source not consulted for this
peril, or failed closed). An `evidenceFingerprint` over every input makes
re-evaluation idempotent — the `(policy_id, evidence_fingerprint)` unique
index turns re-runs into no-ops (no duplicate TriggerEvents, no double
payouts).

## Policy lifecycle

```
QUOTED → ACTIVE → TRIGGERED → PAYOUT_PROPOSED → PAID
                ↘ EXPIRED (admin)
```

- `POST /insurance/quotes` persists a QUOTED policy (deterministic
  premium; flood pricing input fails closed with 503 when a configured
  live flood sidecar is unreachable).
- `POST /insurance/policies/:id/issue` (owner) activates it.
- `POST /insurance/evaluate-triggers` (admin/cron-style) runs the batch:
  ACTIVE policies only, breaches walk ACTIVE → TRIGGERED →
  PAYOUT_PROPOSED and propose the payout.
- `POST /insurance/payouts/:id/confirm` (admin) settles the proposal:
  PAYOUT_PROPOSED → PAID. Stub execution — see below.
- `POST /insurance/policies/:id/expire` (admin) expires an ACTIVE policy.

Illegal transitions answer **409**; ownership violations 403; the
evaluation batch is admin-only.

## Stub/live semantics (fail-closed, non-negotiable)

Mirrors the geo-intel flood-ml doctrine:

- `WEATHER_API_URL` unset → `StubWeatherProvider` (deterministic,
  hash-seeded daily series per h3 cell + season; per-cell seasonal factor
  so both triggering and non-triggering outcomes occur).
- `WEATHER_API_URL` set but `WEATHER_API_KEY` missing → the factory
  throws `ProviderConfigError` (fail closed at resolution).
- Live provider configured but unreachable → the evaluation run marks the
  affected cells `unavailable`, persists **nothing** for them, and
  `POST /insurance/evaluate-triggers` answers **503**. The stub is NEVER
  silently substituted when live was configured. Live calls use a 5s
  timeout, 2 retries (never on 4xx) and a call-time circuit breaker
  (3 consecutive failures open it for 30s).
- Flood triggers reuse `createFloodRiskDriver` (`FLOOD_ML_DRIVER=http` +
  `FLOOD_ML_URL`), with identical fail-closed behaviour at quote time and
  evaluation time.

## Payout rail (STUB execution)

Payouts never invent money movement — they book through the existing
`LedgerService` double-entry ledger:

1. **Proposal** (`insurance-payout-proposal:{triggerEventId}`
   idempotency key): debit `insurer:claims_expense` (expense), credit
   `insurer:claims_payable` (liability).
2. **Settlement** (`insurance-payout-settlement:{payoutId}`): debit
   `insurer:claims_payable`, credit
   `farmer:{userId}:insurance_payouts` (asset).

Every payout row is labelled `execution:'stub'`. Ledger idempotency keys
plus the evidence-fingerprint unique index make the whole chain replay-
safe.

## External gates (NOT done in this wave)

1. **Insurer MOU** — a signed agreement with a licensed underwriter
   before any product is offered as real cover.
2. **Weather provider contract** — the live provider must implement
   `GET {WEATHER_API_URL}/v1/observations?cell=<h3>&season=<label>&days=<n>`
   (header `x-api-key`) returning
   `{ "rainfall_mm": number[], "max_temp_c": number[] }`, plus
   `GET /healthz`. Until then, all weather evidence is `basis:'stub'`.
3. **Payout rail activation** — real disbursement (payment driver
   transfer to the farmer) replaces the stub settlement entry only after
   the insurer MOU and regulator review. The `execution` column is
   CHECK-constrained to `'stub'` in migration 031.
4. **Premium collection** — issuance currently records no premium
   payment; collecting premiums (wallet/PSP) is a follow-up wave.

## Insurer read API

Underwriter-facing surface on the partner-api pattern (OAuth token or
developer API key with scope `insurance:read`, rate-limited by the
partner guard):

- `GET /partner/insurance/portfolio` — policy counts by status, total
  sum insured, premiums, payout totals, trigger event count.
- `GET /partner/insurance/trigger-events` — every trigger event with the
  full evidence payload for independent recomputation.

## Honest limits

- Weather/flood inputs are simulated in the default deployment; trigger
  events in stub mode are demonstrations of the rail, not payable claims.
- One trigger per policy per season in practice (the policy leaves ACTIVE
  after the first breach); multi-peril stacking is out of scope.
- The observation window is evaluated against the current provider
  snapshot at run time; historical window reconstruction is the live
  provider's responsibility (see contract above).
- Premiums are quoted but not collected (gate 4); the insurer ledger
  accounts are platform bookkeeping, not reconciliation with a real
  underwriter account.
