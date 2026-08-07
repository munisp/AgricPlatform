# vsla-carbon — VSLA groups + carbon MRV (wave VSLACARBON)

Additive module. Two capabilities, one schema (`vsla_carbon`, migration
`infra/postgres/037_vsla_carbon.sql`):

1. **VSLA groups** — village savings & loan association registry (optionally
   chapter-linked to the chapters model), membership, savings cycles
   (open/close), member contributions, deterministic pro-rata share-outs and
   small internal loans with a flat simple-interest schedule.
2. **Carbon MRV** — practice-adoption plots registered by VSLA groups
   (H3 res-9 index computed in the app layer via `geo/h3.service.ts` — **no
   PostGIS**), seasonal evidence (farmer/enumerator attestations with an
   optional Sentinel-2 NDVI linkage via the crop-ml contract), deterministic
   carbon **ESTIMATES**, and donor/MRV reporting with CSV export.

## Honesty doctrine (non-negotiable)

- Every carbon figure is an **ESTIMATE** from the versioned coefficient table
  (`carbon-coefficients.ts`, `CO2E_COEFFICIENT_VERSION`) and is labelled
  `basis: 'estimate'` — in the API, in reports and in the UI
  (`ESTIMATE — not verification-grade` badge).
- NDVI-linked evidence stores the provider's own basis (`'stub'|'live'`)
  verbatim. The stub provider (default) is clearly labelled
  `STUB — simulated` and is **never** upgraded or presented as live.
- This module does **NOT** issue, trade or imply carbon credits and does
  **NOT** claim any carbon-standard (Verra/Gold Standard/etc.) endorsement.
  The coefficient table is a conservative screening model synthesised from
  public IPCC/FMNR literature (citations in `carbon-coefficients.ts`), not a
  methodology.

## External gates (blocking, out of scope here)

1. **Carbon standard methodology approval** — before any figure could feed a
   credit issuance pipeline, an accredited methodology must be selected and
   project validation/verification contracted with an approved VVB.
2. **Donor programme agreement** — MRV reports are shared with donors only
   under a signed programme agreement covering data use, safeguarding and
   benefit-sharing.

## Money doctrine

Money lives in the **finance ledger** (double-entry, integer kobo). The
`vsla_carbon` tables hold operational records only and cross-reference ledger
journal entries (`ledger_entry_id`). Postings:

| Flow | Postings | Solvency guard |
|---|---|---|
| contribution | DR `vsla:<gid>:cash` / CR `vsla:<gid>:member:<uid>` | — |
| loan issue | DR `vsla:<gid>:loans_receivable` (total due) / CR `vsla:<gid>:cash` (principal) + CR `vsla:<gid>:interest_income` | cash ≥ 0 |
| repayment | DR `vsla:<gid>:cash` / CR `vsla:<gid>:loans_receivable` | receivable ≥ 0 |
| share-out | DR `vsla:<gid>:member:<uid>` (+ `vsla:<gid>:interest_income` for surplus) / CR `vsla:<gid>:cash` | cash ≥ 0 |

Ledger invariants are tested: never-negative asset accounts, double-entry
conservation, idempotent replays (unique idempotency keys at both the ledger
and the operational tables; cycle close replays return the same share-out
report). Revenue accounts (`interest_income`) are credit-normal and are
deliberately not solvency-guarded — the distributed surplus can never exceed
the interest credited (surplus = repayments − outstanding principal ≤ booked
interest).

Share-outs are deterministic: pro-rata over contribution totals with a
largest-remainder top-up (ties break by memberId) so
`sum(shares) == distributable pool` exactly; residuals (pool locked in
outstanding loans) stay visible as member liabilities.

## NDVI provider port (fail-closed)

`ndvi.provider.ts` wraps the **existing** crop-ml client contract
(`credit/geo-verification/crop-intel.drivers.ts` ↔ `services/crop-ml`
`POST /v1/crop/assess-plot`). STUB is the default; LIVE is env-selected and
fails closed: a configured-but-unreachable sidecar answers **503** — the stub
is never silently substituted.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CROP_ML_DRIVER` | `stub` | `stub` or `http` — NDVI linkage provider |
| `CROP_ML_URL` | — | Required when `CROP_ML_DRIVER=http` (crop-ml sidecar base URL) |

No other production env vars are required by this module (`DATABASE_URL` and
the platform-wide vars already exist).

## RBAC

| Role | Capabilities |
|---|---|
| farmer | member contributions (own), loan repayment (own), own-plot registration/evidence/estimates |
| chapter_lead | group admin: create groups, membership, cycles, share-outs, loans, plots, reports |
| enumerator | field evidence submissions, estimates |
| donor | MRV reports + CSV export |
| regulator | MRV reports + CSV export (oversight) |
| admin | everything |

## API surface

`POST/GET /vsla-carbon/groups[/:id]`, `POST/GET …/members`, `POST/GET …/cycles`,
`POST/GET /vsla-carbon/cycles/:id/contributions`, `POST …/close`,
`GET …/share-out`, `POST/GET …/loans`, `POST/GET /vsla-carbon/loans/:id/repayments`,
`POST/GET /vsla-carbon/plots[/:id]`, `POST/GET …/evidence`, `POST …/estimate`,
`GET …/estimates`, `GET /vsla-carbon/coefficients`, `GET /vsla-carbon/ndvi/status`,
`GET /vsla-carbon/reports/group/:id`, `GET /vsla-carbon/reports/programme`,
`GET /vsla-carbon/reports/export?format=csv|json`.
