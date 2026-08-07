# Electronic warehouse receipts (e-WHR)

Wave WAREHOUSE (Innovation #5). NestJS module
`apps/api/src/modules/warehouse`, migration `infra/postgres/034_warehouse.sql`
(schema `warehouse`), web UI under `apps/web/app/(dashboard)/warehouse`.

> **Not production-ready.** Activation is externally gated on a licensed
> warehouse operator network and a national collateral registry integration
> (see "External gates"). Everything external is STUB-driven by default and
> clearly labelled as such in the API records and the web UI.

## Domain model

| Entity | Table | Notes |
| --- | --- | --- |
| Certified warehouse | `warehouse.warehouses` | Admin-managed registry: name, state/LGA, lat/long → H3 cell (app-layer, no PostGIS), capacity (tonnes), certification status (`pending → certified / suspended`). |
| Deposit | `warehouse.deposits` | Farmer crop-lot deposit; optional `lot_id` link to `traceability.commodity_lots` (owner-checked, one open deposit per lot). Status `received → graded → issued → withdrawn`. Grading is a jsonb record (grade A/B/C, moisture %, bag count, weight kg, grader, timestamp). |
| e-WHR | `warehouse.receipts` | Unique `receipt_number` (`WHR-<year>-<8 hex>`), HMAC-SHA256 `signature` over a versioned canonical payload (receipt number, parties, grade, quantities, issued-at, nonce). Status `active → pledged → released → redeemed` (`released → pledged` re-pledge allowed). |
| Pledge (lien) | `warehouse.pledges` | Mirrors the livestock-trade `LivestockLien` precedent and the credit module's collateral concept (`credit.collateral`). At most one active pledge per receipt (partial unique index — no triggers). Carries the collateral-registry reference and its `basis` label. |
| Transfer | `warehouse.transfers` | Append-only ownership-transfer audit trail. |

**Money stays in the finance ledger** (double-entry). Warehouse tables hold
operational records only; no kobo moves in this module.

## Receipt signature scheme

`apps/api/src/modules/warehouse/receipt-crypto.ts` — identical doctrine to
the agent-banking voucher: a versioned, dot-joined canonical payload in a
fixed field order, HMAC-SHA256 keyed by `WAREHOUSE_RECEIPT_SECRET`, verified
server-side only with constant-time comparison. The dev default secret is
clearly labelled `…-INSECURE`; production without the env var refuses to
sign (lazy, at signing time). `GET /warehouse/receipts/:id/verify`
recomputes the signature for tamper evidence.

## STUB-first external ports (fail-closed)

| Port | Env flag | Default | Live behaviour |
| --- | --- | --- | --- |
| Warehouse-operator certification feed | `WAREHOUSE_CERTIFICATION_DRIVER` | Deterministic stub (`basis:'stub'`, stable per licence ref) | Requires `WAREHOUSE_CERTIFICATION_URL` + `WAREHOUSE_CERTIFICATION_API_KEY`. Unreachable → provider error → **503**. Production boot aborts when the flag is set without config. The stub is never silently substituted. |
| Collateral registry | `COLLATERAL_REGISTRY_DRIVER` | Deterministic stub reference `STUB-<12 hex>` (`basis:'stub'`) | Requires `COLLATERAL_REGISTRY_URL` + `COLLATERAL_REGISTRY_API_KEY`. Same fail-closed doctrine: a pledge is never recorded as registered when the registry did not confirm it, and a lien is never released when the registry release cannot be confirmed. |

Driver labels are exposed at `GET /warehouse/integrations/status` and
surfaced in the web UI as STUB badges.

## External gates (before activation)

1. **Licensed warehouse operator network** — the certification feed contract
   must be signed and the live driver validated end-to-end.
2. **National collateral registry integration** — lien registration/release
   must be confirmed by the statutory registry for pledges to be enforceable.

Until both clear, every certification check and registry reference is
STUB-labelled and the module must be described as a demo rail only.

## API surface (`/warehouse`)

| Route | Role | Purpose |
| --- | --- | --- |
| `GET /warehouses` | public | Browse the registry (state/LGA/certification filters). |
| `POST /warehouses` | admin | Register a warehouse (certification starts `pending`). |
| `GET /warehouses/:id` | public | Warehouse detail. |
| `POST /warehouses/:id/certification` | admin | Re-check certification via the feed port (STUB-labelled). |
| `POST /deposits` | farmer, admin | Deposit a crop lot (optional `lotId` link). |
| `GET /deposits/mine` | farmer, admin | Own deposits. |
| `GET /deposits/:id` | owner/admin/regulator | Deposit detail. |
| `POST /deposits/:id/grading` | admin | Record quality grading (received → graded). |
| `POST /deposits/:id/receipt` | admin | Issue the e-WHR (idempotent per deposit). |
| `GET /receipts/mine` | farmer, admin | Own receipts. |
| `GET /receipts/:id` | parties | Receipt detail (owner, pledge-holding lender, admin, regulator). |
| `GET /receipts/:id/verify` | public | Re-verify the HMAC signature. |
| `GET /receipts/:id/pledges` | parties | Pledge history. |
| `GET /receipts/:id/transfers` | parties | Transfer audit trail. |
| `POST /receipts/:id/pledge` | lender, admin | Register a lien (collateral-registry recorded). |
| `POST /receipts/:id/release` | lender, admin | Release the active pledge (registering lender or admin). |
| `POST /receipts/:id/transfer` | owner, admin | Ownership transfer (not while pledged/redeemed). |
| `POST /receipts/:id/redeem` | owner, admin | Withdraw the grain (not while pledged). |
| `GET /pledges/mine` | lender, admin | Lender's pledge book. |
| `GET /registry/export` | regulator, admin | Read-only audit export (receipts + pledges + transfers). |
| `GET /integrations/status` | public | External-port driver labels. |

## Cross-cutting

- **Domain events** (`warehouse.*`): `warehouse.warehouse.registered`,
  `warehouse.certification.checked`, `warehouse.deposit.received`,
  `warehouse.deposit.graded`, `warehouse.receipt.issued`,
  `warehouse.receipt.status_changed` (transactional outbox on pg),
  `warehouse.receipt.pledged` / `.released` / `.transferred` / `.redeemed`
  (collateral and ownership movements).
- **Idempotency**: the global `Idempotency-Key` interceptor covers all
  mutations; additionally receipt issuance is idempotent per deposit,
  pledge release and redemption replay safely, and state transitions use
  compare-and-set (`updateExpected`).
- **Audit**: certification checks, pledges, releases, transfers and
  redemptions write tamper-evident `AuditService` entries.
- **Entitlement before state**: party checks run before state-machine
  validation so non-parties cannot probe receipt state (403 vs 400),
  mirroring the mechanization booking precedent.
