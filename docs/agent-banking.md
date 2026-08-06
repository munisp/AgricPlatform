# Agent Banking (wave AGENTBANK)

Rural agent banking: field agents run a **ledger-backed float** so farmers can
cash in and cash out at the village level, with **signed offline vouchers**
for connectivity gaps, deterministic commissions, USSD agent ops and daily
reconciliation. Migration `infra/postgres/032_agent_banking.sql` (schema
`agent_banking`).

## Money-movement invariants

ALL value movement posts through the finance double-entry ledger
(`LedgerService`) — the agent float is a ledger sub-account, never a parallel
money store:

| Flow | Postings | Solvency guard (in-transaction) |
| --- | --- | --- |
| Cash-in (farmer deposits at agent) | DR `member:<farmer>:wallet` / CR `agent:<id>:float` | float ≥ 0 |
| Cash-out (farmer withdraws at agent) | DR `agent:<id>:float` / CR `member:<farmer>:wallet` | wallet ≥ 0 |
| Float top-up settlement | DR `agent:<id>:float` / CR `platform:cash` | `platform:cash` ≥ 0 |
| Commission accrual | DR `platform:commission_expense` / CR `agent:<id>:commission_payable` | — |

Consequences, all covered by tests:

- **Overdraft is impossible.** The solvency check runs inside the ledger
  posting transaction; an underfunded posting rolls back atomically. Agent
  float and farmer wallets can never go negative.
- **Idempotency is mandatory.** Cash-in/out take a client idempotency key
  (unique in `agent_banking.transactions`); replays return the original
  record and never double-post. Ledger entries carry deterministic
  idempotency keys (`agent-tx:<key>`, `agent-float-topup:<id>`,
  `voucher-redemption:<id>`, `agent-commission:<key>`).
- **State machines advance by compare-and-set.** Concurrent transitions
  (top-up decision, voucher redemption) lose with a 409 instead of
  double-settling.
- **Daily limits.** Each agent has `daily_limit_kobo`; the sum of a day's
  cash-in/out/voucher volume may not exceed it.
- **Reconciliation is ledger-derived.** The daily summary (opening float,
  volumes by type, commission, closing float) replays the float account's
  journal entries against the day bounds; it is exportable JSON
  (`GET /agent-banking/agents/:id/reconciliation?date=YYYY-MM-DD`).

## Voucher cryptography

Offline vouchers bridge connectivity gaps: the agent issues a voucher while
online (or ahead of a known outage); the farmer redeems it later, once, at
any online touchpoint (API or agent USSD).

- Payload `{voucherId, agentId, farmerId, amountKobo, expiry, nonce}` is
  encoded canonically as
  `v1.<voucherId>.<agentId>.<farmerId>.<amountKobo>.<expiry>.<nonce>`
  (field order is part of the contract) and signed with **HMAC-SHA256**
  keyed by the server-side secret `AGENT_VOUCHER_SECRET`.
- **Verification is server-side only** (`verifyVoucherSignature`,
  constant-time compare). The REST redemption path requires presenting the
  signature printed on the voucher; any tampering with amount, farmer,
  expiry or nonce invalidates it (known-answer + tamper vectors in
  `voucher-crypto.spec.ts`).
- States `ISSUED → REDEEMED | EXPIRED | VOIDED`. Redemption posts the ledger
  entry and CAS-flips the voucher atomically (same discipline as loan
  disbursement). **Replay → 409.** Expired vouchers answer 410 and are
  lazily transitioned to `EXPIRED`.
- The development default secret is clearly labelled
  (`agent-banking-dev-voucher-secret-INSECURE`); production refuses to boot
  the signing path without `AGENT_VOUCHER_SECRET`.
- USSD redemption authenticates the agent by their phone session, so the
  stored signature stands in for presentation; the HMAC integrity check
  still runs server-side.

## Stub / live channels (fail-closed doctrine)

- **Farmer presence proof (OTP).** `OTP_DRIVER=stub` (default) is a
  deterministic, clearly labelled development channel: the expected code is
  the first 6 digits of a SHA-256 over `(farmerId, idempotencyKey)`. Nothing
  is sent anywhere. `OTP_DRIVER=live` requires `OTP_PROVIDER_URL` +
  `OTP_PROVIDER_API_KEY` and **fails closed**: production boot aborts without
  them, and every verification call answers **503** in this build (no
  provider client is integrated yet) — never a silent pass.
- **Mojaloop interop.** `GET /agent-banking/interop/status` and
  `POST /agent-banking/interop/quote` go through the existing Mojaloop
  adapter in **stub/simulator mode only** (deterministic, labelled
  `stub-fixture (simulated …)`; simulator mode proves the adapter contract
  against a Mojaloop simulator endpoint). There is **no live interop**: no
  funds move through any Mojaloop switch from this build.
- **USSD.** The agent-banking USSD callback
  (`POST /agent-banking/ussd/callback`) mirrors the agronomy channel: pure
  CON/END menu engine (float balance, last 5 transactions, voucher
  redemption), 3-minute sessions with idempotent replay, and the endpoint
  stays 404 unless `USSD_DRIVER=live|sandbox` with the Africa's Talking
  credentials.

## Roles

`agent` (new platform role, additive in `packages/shared`): owns a float —
requests top-ups, runs cash-in/out, issues/redeems/voids vouchers, views own
statements. `admin` (supervisor): registers/governs agents, decides and
settles top-ups, sees everything. `farmer`: self-service transaction history
and voucher redemption for their own vouchers. Ownership checks are enforced
in the service on top of the role guard.

## External gates (before any live activation)

1. **Regulatory.** CBN agent-banking guidelines require operating under a
   licensed super-agent / partner bank. This codebase implements the
   platform side only; the partnership, agent due-diligence and consumer-
   protection obligations are external and unresolved.
2. **OTP provider.** A real presence-proof channel (SMS OTP vendor with
   Nigeria DND routing) must be contracted and the live driver integrated;
   today `OTP_DRIVER=live` is deliberately a 503.
3. **Legal review required before activation.** Commission table
   (`commission.ts`), daily limits and voucher terms are placeholders
   pending commercial and legal sign-off.

## Honest limits

- No live interop of any kind: Mojaloop is stub/simulator only, OTP is a
  deterministic stub, USSD is gated off by default.
- The reconciliation is per-agent per-day; cross-agent network-level
  settlement reporting is out of scope for this wave.
- Voucher amounts are bounded only by the agent float and daily limit at
  redemption time; issuance is deliberately not reserved against the float
  (vouchers are claims, not holds — documented for the compliance review).
- USSD voucher redemption requires typing the full voucher id on a feature
  phone; a short-code scheme is future work.
