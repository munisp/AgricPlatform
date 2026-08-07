# Input Vouchers (wave NINVOUCHER)

NIN-linked government input-subsidy e-vouchers: subsidy programmes with a
ledger-encumbered budget envelope, NIN-verified beneficiary enrolment,
voucher allocation/distribution, redemption at agro-dealers, and settlement
reconciliation for regulators/donors.

## Honest status — STUB first

- **Identity verification runs in STUB mode by default and in every demo.**
  The stub driver is deterministic (the verdict and name-match score derive
  from a stable SHA-256 hash of the NIN) and is clearly labelled `basis:
  'stub'` in API responses, UI badges and exports. It is **not** a real NIN
  check — nothing is queried anywhere.
- **We do NOT claim NIMC integration or any government partnership.** The
  live driver (`NIN_DRIVER=live`) is reserved plumbing only: no vendor
  client is integrated, so every call fails closed with 503, and production
  boot aborts when the flag is set without `NIN_PROVIDER_URL` +
  `NIN_PROVIDER_API_KEY`.

## External gates (blocking any live launch)

1. **NIMC or licensed identity vendor contract** — legal basis + API access
   for NIN verification, then a real `LiveIdentityDriver` client.
2. **Programme sponsor MOU** (government agency / donor) — funding source,
   allocation rules sign-off and settlement terms for agro-dealer payouts.

Until both gates clear, all identity data is stub-labelled and all money
movement stays inside the platform's double-entry finance ledger.

## Data protection (NDPA 2023 posture)

The plaintext NIN is **never persisted**. Only a salted HMAC-SHA256 hash
(dedupe key) and a last-3 mask (operator display) are stored
(`input_vouchers.beneficiaries`). The salt comes from `NIN_HASH_SALT`;
production refuses the clearly-labelled development default.

## Money flow (finance ledger, double-entry)

Voucher tables hold operational records only. Ledger flows:

| Step        | Posting (idempotency key)                                              |
|-------------|------------------------------------------------------------------------|
| Activation  | DR `platform:subsidy_budget` / CR `programme:<id>:liability` (`input-voucher-programme:<id>`) |
| Redemption  | DR `programme:<id>:liability` / CR `supplier:<id>:receivable` (`input-voucher-redemption:<voucherId>`) |
| Void/expiry | DR `programme:<id>:liability` / CR `platform:subsidy_budget` (`input-voucher-release:<voucherId>`) |

Invariant: liability credit balance == budget − redeemed − released. The
reconciliation report (`GET /input-vouchers/programmes/:id/reconciliation`)
asserts this tie and returns `discrepancyKobo` — anything non-zero is an
integrity breach.

## Voucher lifecycle

allocate (post NIN-verification, idempotent on the client key) → distribute
(farmer sees the voucher) → redeem at an agro-dealer (supplier role, against
an invoice reference). Anti-double-spend: CAS state machine
ISSUED→REDEEMED/EXPIRED/VOIDED, UNIQUE `redemptions.voucher_id`, and the
idempotent ledger posting — a replay is a 409, a voucher pays out once.

## RBAC

- `farmer` — view own vouchers (`/input-vouchers/farmers/me/vouchers`)
- `supplier` (agro-dealer) — redeem against an invoice
- `admin` — programmes, enrolment, allocation, distribution, void/expire
- `regulator`, `donor` — programme reads + reconciliation exports

## Environment flags

| Variable               | Default | Meaning                                                        |
|------------------------|---------|----------------------------------------------------------------|
| `NIN_DRIVER`           | `stub`  | `stub` = deterministic labelled dev driver; `live` = reserved fail-closed vendor port |
| `NIN_PROVIDER_URL`     | —       | Required when `NIN_DRIVER=live` (production boot aborts without it) |
| `NIN_PROVIDER_API_KEY` | —       | Required when `NIN_DRIVER=live`                                |
| `NIN_HASH_SALT`        | dev default (labelled INSECURE) | **Production-required.** Salt for the NIN HMAC hash |

## Schema

`infra/postgres/035_input_vouchers.sql` — schema `input_vouchers`
(programmes, beneficiaries, vouchers, redemptions). No PostGIS, no triggers.
