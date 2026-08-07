# Input Subsidy E-Vouchers (wave NINVOUCHER)

NIN-linked government input-subsidy e-vouchers for the AgricPlatform: an
admin/regulator creates a subsidy programme (e.g. "2026 wet-season
fertiliser") with allocation rules and a budget envelope; farmers enrol via
NIN verification; vouchers are allocated, distributed, redeemed at
agro-dealers and reconciled for regulators/donors.

## Honest status

- **STUB-first identity.** The identity verification adapter ships with a
  deterministic STUB driver (verdict + name-match score derived from a
  stable hash of the NIN) that is clearly labelled everywhere: API
  `verificationBasis`/`basis` fields, the `STUB identity check` UI badge,
  and this page. The platform does **not** integrate NIMC and does **not**
  claim any government partnership.
- **Fail-closed live port.** `NIN_DRIVER=live` reserves the NIMC/licensed
  vendor integration. Without `NIN_PROVIDER_URL` + `NIN_PROVIDER_API_KEY`,
  production boot aborts; even with them, every call answers 503 until a
  vendor client exists. The stub is never silently substituted.

## External gates before any live launch

1. **NIMC or licensed identity vendor contract** — legal basis and API
   access for real NIN verification.
2. **Programme sponsor MOU** — government agency or donor funding the
   budget envelope, with settlement terms for agro-dealer payouts.

## Money stays in the finance ledger

Voucher tables (`input_vouchers` schema, migration 035) hold operational
records only. The budget envelope is encumbered on programme activation
(DR `platform:subsidy_budget` / CR `programme:<id>:liability`); redemption
moves value to the agro-dealer receivable (DR programme liability / CR
`supplier:<id>:receivable`); void/expiry releases the encumbrance. The
reconciliation endpoint asserts the double-entry tie
(`liability == budget − redeemed − released`) and reports
`discrepancyKobo` — a non-zero value is an integrity breach, not a rounding
issue.

## Lifecycle and anti-double-spend

allocate (idempotent on the client key) → distribute → redeem against an
agro-dealer invoice reference. A voucher pays out exactly once: the
ISSUED→REDEEMED/EXPIRED/VOIDED state machine advances via compare-and-set,
`redemptions.voucher_id` is UNIQUE, and the ledger posting is idempotent on
`input-voucher-redemption:<voucherId>`. Replays return the original record
or a 409.

## Data protection (NDPA 2023)

Plaintext NINs are never stored — only a salted HMAC-SHA256 hash
(`NIN_HASH_SALT`, production-required) and a last-3 mask for operators.

## API surface (`/input-vouchers`)

| Route                                                       | Roles                    |
|-------------------------------------------------------------|--------------------------|
| `POST/GET /programmes`, `POST /programmes/:id/activate|close` | admin (GET: + regulator, donor) |
| `POST/GET /programmes/:id/beneficiaries`                    | admin                    |
| `POST/GET /programmes/:id/vouchers`                         | admin (GET: + regulator, donor) |
| `GET /programmes/:id/reconciliation`                        | admin, regulator, donor  |
| `GET /farmers/me/vouchers`                                  | farmer, admin            |
| `POST /vouchers/:id/distribute|void|expire`                 | admin                    |
| `POST /vouchers/:id/redeem`                                 | supplier, admin          |
| `GET /identity/status`                                      | admin                    |

## Environment flags

- `NIN_DRIVER` (default `stub`)
- `NIN_PROVIDER_URL`, `NIN_PROVIDER_API_KEY` (required for `live`)
- `NIN_HASH_SALT` (**production-required**)

See also `apps/api/src/modules/input-vouchers/README.md`.
