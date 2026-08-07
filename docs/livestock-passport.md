# Digital Livestock Passport (wave-livestock-passport)

Innovation #9: a per-animal, verifiable identity document that aggregates
the platform's livestock domain into a single passport — with a
tamper-evident event chain, a two-party ownership-transfer handshake and an
unauthenticated public verification endpoint for QR tags at the market.

## Architecture

The passport is a **thin anchor**, not a re-implementation. Domain history
is composed at read time through the existing repositories:

- **Identity** — `livestock.animals` (wave L1a). One passport per animal
  (`UNIQUE(animal_id)`).
- **Health** — `livestock.health_records` (wave L1b). The vaccination
  summary is reversal-aware (a record annulled by a `reversalOfId` entry is
  excluded) and mirrors the health grading schedule logic
  (`VACCINATION_SCHEDULES` per species).
- **Movement legality** — `livestock.movements` + `movement_permits` (wave
  L1b). A movement is "legal" only when it references a permit that was
  never revoked.
- **Liens / insurance** — `livestock.liens`, `livestock.insurance_policies`
  (wave L1c). The active-lien transfer block mirrors
  `createLienTransferGuard` and is re-checked when the buyer confirms.
- **Ownership** — executed transfers write through
  `AnimalRepository.transferOwnership`, so `livestock.ownership_transfers`
  remains the single ownership ledger.

Own tables (schema `livestock_passport`, migration `036`):

- `passports` — anchor + HMAC code material + honest `tag_check_basis`.
- `passport_events` — **append-only** hash chain (no update/delete path in
  the pg repository; no DB triggers, per lint:sql doctrine).
- `passport_transfers` — pending/confirmed/cancelled handshake; partial
  unique index enforces one pending transfer per passport.

## Hash chain

Identical scheme to the EUDR custody chain (and reuses its canonical-JSON
serialiser and genesis constant): each event stores `seq`,
`prev_event_hash` and `event_hash = sha256(canonicalJson({actorId,
passportId, payload, prevEventHash, seq, type}))`. `verifyPassportChain`
recomputes the chain and detects payload tampering, prev-link surgery and
seq gaps. Event types: `ISSUED`, `TRANSFER_INITIATED`,
`TRANSFER_CONFIRMED`, `TRANSFER_CANCELLED`, `SUSPENDED`, `REINSTATED`,
`REVOKED`.

## Passport code + public verification

Wire format: `LSP.{animalId}.{nonce8}.{sig16}` where `sig16` is the first
16 hex chars of `HMAC-SHA256(LIVESTOCK_PASSPORT_SECRET,
"v1.{passportId}.{animalId}.{nonce}")` — the agent-banking voucher pattern.
Verification is server-side and constant-time; forged, replayed or
malformed codes answer 404 without an oracle.

`GET /livestock-passport/verify/:passportCode` (unauthenticated) returns a
**redacted** view: animal identity, vaccination summary, movement-legality
summary, encumbrance flags, chain status and `qr.verifyPath`. Owner PII is
initials-only ("A.B."); lien amounts and lender identity are never exposed.

## Ownership transfer lifecycle

1. **Seller initiates** (`POST /livestock-passport/:id/transfers`) —
   requires current ownership, active passport, live animal, known buyer,
   **no active lien** (409 otherwise).
2. **Buyer inspects** — the named buyer can read the full document while
   the transfer is pending.
3. **Buyer confirms** (`POST .../transfers/:transferId/confirm`) —
   re-validates passport status, seller ownership and the lien guard, then
   executes the ownership change and moves the passport to the buyer.
4. **Seller/admin cancels** any time before confirmation.

Initiation (seller) and confirmation (buyer) each write an audit record and
a chain event — the both-party audit trail. Mutations accept the global
`Idempotency-Key` header (replay-safe).

## External authority port (`AnimalIdAuthorityProvider`)

| Mode | Behaviour |
| --- | --- |
| STUB (default) | Deterministic FNV-1a verdict per tag, `basis:'stub'`, `STUB-NAIS-*` references. Honestly labelled in API, UI (`STUB — simulated check, no registry contacted`) and docs. |
| LIVE (`ANIMAL_ID_AUTHORITY_MODE=live` or URL set) | Requires `ANIMAL_ID_AUTHORITY_URL` + `ANIMAL_ID_AUTHORITY_API_KEY`; missing config throws `ProviderConfigError` at **boot**. Unreachable authority → 503 at issuance (fail-closed; the stub is never substituted). |

**External gate:** no national animal-ID authority or RFID tag registry
integration is contracted. Activation requires the state veterinary
authority + tag registry onboarding (contract, credentials, data-sharing
agreement). Nothing in the platform claims a government integration.

**Legal gate:** lien-based transfer blocking inherits the livestock-trade
caveat — secured-transaction/collateral-registry review (Secured
Transactions in Movable Assets Act, 2017) before production activation.

## API surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /livestock-passport/animals/:animalId` | owner/admin | Issue (one per animal) |
| `GET /livestock-passport/mine` | authenticated | My composite passports |
| `GET /livestock-passport/:id` | owner/vet/regulator/admin/pending buyer | Full document |
| `GET /livestock-passport/:id/events` | same | Chain + recomputed verification |
| `POST /livestock-passport/:id/transfers` | owner | Initiate transfer |
| `GET /livestock-passport/transfers?direction=` | authenticated | Incoming/outgoing transfers |
| `POST /livestock-passport/transfers/:id/confirm` | named buyer | Execute ownership change |
| `POST /livestock-passport/transfers/:id/cancel` | seller/admin | Cancel pending |
| `GET /livestock-passport/verify/:code` | **public** | Redacted verification + QR payload |
| `GET /livestock-passport/export/oversight` | regulator/admin | Oversight export |
| `GET /livestock-passport/authority/status` | authenticated | Authority port status (stub-labelled) |
| `POST /livestock-passport/:id/suspend` / `reinstate` | regulator/admin | Fraud hold lifecycle |

## Environment variables

- `LIVESTOCK_PASSPORT_SECRET` — **required in production** (>= 16 chars);
  the API refuses to boot with the labelled dev default.
- `ANIMAL_ID_AUTHORITY_MODE` — `stub` (default) | `live`.
- `ANIMAL_ID_AUTHORITY_URL`, `ANIMAL_ID_AUTHORITY_API_KEY` — live mode only.
