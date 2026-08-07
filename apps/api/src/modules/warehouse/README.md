# Warehouse module — electronic warehouse receipts (e-WHR)

Innovation #5 (migration `infra/postgres/034_warehouse.sql`, schema `warehouse`).
Full doctrine, API surface and the external gates: `docs/warehouse-receipts.md`.

## What this is

An operational registry for Nigerian smallholder grain storage:

1. **Certified warehouse registry** (admin-managed): name, state/LGA, H3 cell
   (app-layer H3, no PostGIS), capacity, certification status.
2. **Deposit lifecycle**: farmer deposits a crop lot (optional link to a
   traceability `CommodityLot`) → quality grading (grade, moisture %, bag
   count, weight) recorded by the warehouse operator/admin → **e-WHR issued**
   with a unique receipt number and an HMAC-SHA256 signed payload (same
   scheme as the agent-banking voucher).
3. **Pledge/lien**: a receipt can be pledged to a lender as loan collateral
   (`ACTIVE → PLEDGED → RELEASED / REDEEMED`), mirroring the livestock-trade
   lien precedent and the credit module's collateral concept.
4. **Transfer + redeem**: ownership transfers carry an append-only audit
   trail; redemption releases the grain and closes the receipt.

Money stays in the finance ledger (double-entry). These tables hold
**operational records only** — no kobo moves here.

## STUB-first external ports (never claim live integration)

| Port | Token | STUB (default) | LIVE driver |
| --- | --- | --- | --- |
| Warehouse-operator certification feed | `WAREHOUSE_CERTIFICATION_FEED` | Deterministic hash-labelled fixture (`basis:'stub'`) | `WAREHOUSE_CERTIFICATION_DRIVER=live` + `WAREHOUSE_CERTIFICATION_URL` + `WAREHOUSE_CERTIFICATION_API_KEY`; fails closed 503 when unreachable; production boot aborts when the flag is set without config |
| Collateral registry | `COLLATERAL_REGISTRY` | Deterministic `STUB-…` reference (`basis:'stub'`) | `COLLATERAL_REGISTRY_DRIVER=live` + `COLLATERAL_REGISTRY_URL` + `COLLATERAL_REGISTRY_API_KEY`; fail-closed as above |

The STUB basis label travels with every certification check and pledge
record and is shown in the web UI. **Nothing here is a live integration.**

## External gates (required before activation)

- Licensed warehouse operator network integration (certification feed).
- National collateral registry integration (lien registration/release).

Until both clear, this module is a demo rail — not production-ready.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `WAREHOUSE_RECEIPT_SECRET` | **production** | HMAC key for receipt signatures. Boot is unaffected (resolution is lazy at signing time) but signing in production without it throws — set it in any real deployment. |
| `WAREHOUSE_CERTIFICATION_DRIVER` | no (`stub`) | `stub` or `live`. |
| `WAREHOUSE_CERTIFICATION_URL` / `WAREHOUSE_CERTIFICATION_API_KEY` | live only | Certification feed endpoint + key. |
| `COLLATERAL_REGISTRY_DRIVER` | no (`stub`) | `stub` or `live`. |
| `COLLATERAL_REGISTRY_URL` / `COLLATERAL_REGISTRY_API_KEY` | live only | Collateral registry endpoint + key. |

## RBAC

- **farmer**: deposit, view own deposits/receipts, transfer, redeem.
- **lender**: register/release pledges, view pledged receipts.
- **admin**: warehouse registry, grading, issuance, oversight.
- **regulator**: read-only audit export (`GET /warehouse/registry/export`).
