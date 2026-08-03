# Mechanization Marketplace (Innovation #10, wave-mechanization)

Equipment hire for smallholders: cooperative and individual owners list
machinery (tractor, planter, harvester, sprayer drone, thresher); farmers
book it per hectare and/or per hour; payment is **held** through the finance
ledger and released per a deterministic schedule.

- API module: `apps/api/src/modules/mechanization/` (`/mechanization/*`)
- Persistence: `infra/postgres/033_mechanization.sql` (schema `mechanization`)
- Web: `apps/web/app/(dashboard)/mechanization/` (+ `components/mechanization-live.tsx`)
- Reuses: geo module `H3Service` (service areas, no PostGIS), finance
  `LedgerService` (payment hold/release), geo-intel flood port (advisory only).

## Listings

Owner (cooperative | individual) → type, free-form `specs` jsonb, base
location, rates (`perHaNaira` and/or `perHourNaira`, `perKmNaira`,
`includedKm`), availability windows, and an H3 **service area** computed
server-side as a k-ring disk around the base cell at resolution 5–7
(`serviceAreaRing` 0–10). Plots are matched by computing the plot's cell at
the listing's resolution — a booking outside the disk is rejected.

Operator verification: owners attach an uploaded-licence reference
(`operatorLicenseRef`); status starts `PENDING` and only an **admin** may set
`VERIFIED` / `SUSPENDED`. A listing cannot leave `DRAFT` until the operator
is `VERIFIED`. Lifecycle: `DRAFT → ACTIVE ⇄ PAUSED`.

## Booking workflow

```
REQUESTED ──owner quotes──▶ QUOTED ──farmer confirms (+HOLD)──▶ CONFIRMED
   │                          │                                 │
   ▼                          ▼                                 ▼
CANCELLED ◀──────── either party (schedule below) ─── IN_SERVICE ──both confirm──▶ COMPLETED ──farmer rates──▶ RATED
                                                             │
                                                             ▼
                                                    DISPUTED ──admin──▶ COMPLETED (pay owner)
                                                                    └─▶ CANCELLED (refund farmer)
```

- **Quote** is computed server-side (never client-supplied).
- **Confirm** places the payment HOLD (below) and re-checks the schedule.
- **Completion** needs *both* parties' confirmation; the second one releases
  the hold to the owner. Fallback: an in-service booking auto-completes after
  `windowEnd + 24 h` (`autoCompleteExpired`, admin sweep endpoint).
- **Dispute** freezes the hold; admins resolve 100% one way.

## Pricing engine (pure, `pricing.ts`)

`total = (areaComponent + hourComponent + distanceSurcharge) × seasonalMultiplier`

| Component | Rule |
|---|---|
| area | `area_ha × per_ha` (0 when no per_ha rate) |
| hours | `estimated_hours × per_hour` (0 when no per_hour rate) |
| distance surcharge | `max(0, haversine(plot, base) − includedKm) × per_km` |
| seasonal multiplier | month of `windowStart` via a static 12-month table |

Both rate components are summed when a listing carries both. All money is
**integer kobo** (₦ rates converted once, rounded; owner share of splits
rounded, farmer keeps the remainder — exact conservation). The seasonal table
(April/May planting peak ×1.3, November harvest ×1.25, August lull ×1.0, …)
lives in `SEASONAL_MULTIPLIERS` and is pinned by known-answer tests.

## Scheduling & conflicts

An equipment unit cannot hold overlapping `CONFIRMED`/`IN_SERVICE` bookings.
Each booking reserves its window **plus a travel buffer on both sides** =
`distance / 20 km/h`, capped at 3 h per side. Violations → `409` with
`suggestedWindows`: deterministic nearest-free alternatives (6 h steps, ≤28
days out, inside availability, buffer-checked). Same state ⇒ same
suggestions (tested).

## Payment hold semantics (stub execution mode)

Holds and releases post through the existing `LedgerService` double-entry
abstraction — **no real charges**:

| Event | Postings |
|---|---|
| hold (`mech-hold:<bookingId>`) | debit `platform:mechanization_holds`, credit `member:<farmer>:wallet` |
| release (`mech-release:<bookingId>`) | debit farmer/owner wallet(s), credit `platform:mechanization_holds` (solvency-guarded) |

Idempotency keys make confirm/cancel retries converge. **External gate:**
real escrow (actual farmer money movement) requires payment-rail activation
(`PAYMENT_PROVIDER` adapter + licensed rails); until then the ledger is a
record of intent in stub execution mode.

### Cancellation / hold-release schedule (deterministic)

| Cancelling party | Timing vs window start | Farmer refund | Owner compensation |
|---|---|---|---|
| owner | any time before completion | 100% | 0% |
| admin | any time before completion | 100% | 0% |
| farmer | ≥ 48 h before | 100% | 0% |
| farmer | 24–48 h before | 90% | 10% |
| farmer | < 24 h before / in service | 70% | 30% |
| dispute (unresolved) | — | frozen | frozen |
| admin resolves dispute | — | 100% **or** 0% | 0% **or** 100% |

## Weather advisory hook (advisory only)

At quote time the booking's plot H3 cell centre is assessed through the
geo-intel flood driver port. When severity is `severe`, the quote carries
`advisory.severe = true` — **booking is never blocked**. The `basis` label
always travels with the flag (`<driver>:<source>`, `not-configured`, or
`unavailable:geo-intel`), honouring the fail-closed doctrine: a configured
but unreachable sidecar degrades to an honest `unavailable` basis rather than
fabricating an all-clear.

## Honest limits

- In-memory repositories by default; PostgreSQL via migration 033 behind the
  same ports. No PostGIS — service-area matching is exact H3 cell equality at
  the listing's resolution (res 5–7 only).
- Utilization stats are derived per request (no stored counters) — fine at
  cooperative scale, would need rollup tables at national scale.
- Travel buffer uses a single average speed (20 km/h) — no road routing.
- Seasonal multipliers are a static operator table, not a demand model.
- Farmer wallets can go negative in stub mode (no real charges); the holds
  account is solvency-guarded so releases can never exceed what was held.
