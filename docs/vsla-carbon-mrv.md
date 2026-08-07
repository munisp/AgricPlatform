# VSLA groups + carbon MRV (wave VSLACARBON)

Village savings & loan association (VSLA) groups with ledger-backed savings
cycles, deterministic share-outs and simple-interest internal loans — plus
carbon MRV for agroforestry/conservation practice plots: seasonal evidence,
a fail-closed Sentinel-2 NDVI linkage, deterministic carbon **ESTIMATES** and
donor/MRV reporting with CSV export. Module:
`apps/api/src/modules/vsla-carbon` (schema `vsla_carbon`, migration
`infra/postgres/037_vsla_carbon.sql`); UI: `/vsla-carbon`.

## What is real vs. simulated

| Piece | Status |
| --- | --- |
| Group registry, membership, cycles, loans, repayments | Real |
| Contributions / share-outs / loan postings | Real double-entry ledger postings (never-negative asset accounts, idempotent replays) |
| Plot geo indexing | Real — H3 res-9 computed in the app layer (`geo/h3.service.ts`, h3-js). **No PostGIS** |
| Evidence attestations | Real records (farmer/enumerator, idempotent) |
| NDVI linkage | **STUB by default** — deterministic fixture via the existing crop-ml contract, `basis:'stub'`, labelled `STUB — simulated` in the UI. LIVE via `CROP_ML_DRIVER=http` + `CROP_ML_URL`; configured-but-unreachable answers **503** (fail-closed, stub never substituted) |
| Carbon figures | **ESTIMATE only** — deterministic, versioned coefficient table (`basis:'estimate'`). NOT verification-grade |
| Credit issuance / trading | **OUT OF SCOPE — externally gated** (below) |

## External gates (blocking)

1. **Carbon standard methodology approval.** No figure produced here feeds a
   credit pipeline. Before anything credit-grade exists, an accredited
   methodology (e.g. a Verra/Gold Standard agroforestry methodology) must be
   selected and the project validated/verified by an approved VVB. This
   module claims **no** carbon-standard endorsement.
2. **Donor programme agreement.** Programme MRV reports/exports are shared
   with donors only under a signed programme agreement (data use,
   safeguarding, benefit-sharing).

## Money doctrine

All value movement posts through the finance double-entry ledger (integer
kobo); the `vsla_carbon` tables are operational records cross-referenced by
`ledger_entry_id`:

- **contribution** — DR `vsla:<gid>:cash` / CR `vsla:<gid>:member:<uid>`
- **loan issue** — DR `vsla:<gid>:loans_receivable` (total due) /
  CR `vsla:<gid>:cash` (principal) + CR `vsla:<gid>:interest_income`
  (flat simple interest: `floor(principal * bps / 10_000)`, usury-capped at
  3_000 bps). Pool solvency guarded — the group cannot lend cash it does
  not hold.
- **repayment** — DR `vsla:<gid>:cash` / CR `vsla:<gid>:loans_receivable`
  (receivable never goes negative; overpayment clamps to outstanding).
- **share-out at cycle close** — the distributable pool is the pooled-cash
  ledger balance, split pro-rata over contribution totals with a
  largest-remainder top-up (ties break by memberId, byte-stable):
  `sum(shares) == distributable`. Each payout posts
  DR member liability (+ DR interest income for the surplus share) /
  CR pool cash. When loans are outstanding the unpaid remainder stays as a
  visible member liability (`residual_kobo`).

Ledger invariants under test (`vsla-carbon.service.spec.ts`): never-negative
asset accounts, double-entry conservation on every posting, idempotent
replays of contributions/repayments/closes (unique idempotency keys; a
replayed close returns the same share-out report with `replayed: true`).

## Carbon estimate model

```
co2e_milli_tonnes = hectares_centi * rate[practice] * survival_pct * season_count / (100 * 100)
```

One integer floor at the end — pure, byte-stable, recomputation-safe.
Rates are milli-tonnes CO2e per hectare per year from the committed,
versioned table (`carbon-coefficients.ts`, version `v1.2026.1`):

| Practice | t CO2e/ha/yr | Basis |
| --- | --- | --- |
| agroforestry | 4.0 | IPCC 2006 GL Vol.4 AFOLU agroforestry biomass increments (44/12 CO2:C) |
| fmnr | 3.0 | FMNR parkland regeneration literature, Sahel |
| woodlot | 6.0 | IPCC 2006 GL Vol.4 planted-forest increments, tropical dry |
| conservation_agriculture | 1.0 | IPCC 2019 Refinement Vol.4 soil-carbon factors, reduced disturbance |

Survival defaults to the latest observed evidence rate (season-first), 100%
when no evidence exists; season count is the number of distinct evidenced
seasons. Every persisted estimate names `coefficient_version` and
`basis: 'estimate'`; recompute is idempotent per (plot, season, version).

## Donor/MRV reporting

- `GET /vsla-carbon/reports/group/:id` — per-group: hectares under practice,
  mean survival, estimated CO2e, evidence counts, NDVI-linked counts.
- `GET /vsla-carbon/reports/programme` — aggregate across all groups.
- `GET /vsla-carbon/reports/export?format=csv` — RFC 4180 CSV (one row per
  group + TOTAL), mirroring the analytics export pattern (authenticated file
  download in the web app).

Every figure carries `basisFlags` (`['estimate']` or `['stub','estimate']`
when stub-linked NDVI evidence is present) and the disclaimer
*"Estimate only — not verification-grade; no carbon credits are issued,
traded or implied."*

## RBAC

farmer (own contributions/repayments/plots/evidence) · chapter_lead (group
admin) · enumerator (field evidence, estimates) · donor (reports/export) ·
regulator (oversight reports/export) · admin (all).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CROP_ML_DRIVER` | `stub` | `stub` or `http` — NDVI linkage provider |
| `CROP_ML_URL` | — | Required when `CROP_ML_DRIVER=http` (crop-ml sidecar base URL) |
| `DATABASE_URL` | — | Platform-wide; applies migration 037 to PostgreSQL |
