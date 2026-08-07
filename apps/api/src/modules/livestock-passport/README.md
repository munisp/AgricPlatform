# Livestock Passport (wave-livestock-passport, innovation #9)

Digital livestock passport: one **verifiable identity document per animal**
that AGGREGATES the existing livestock domain instead of rebuilding it:

| Passport section | Source of truth (reused, never duplicated) |
| --- | --- |
| Animal identity (national ID, species/breed/sex, birth estimate) | `livestock.animals` (wave L1a, migration 012) |
| Ownership history | `livestock.ownership_transfers` (wave L1a) — confirmed transfers execute through `AnimalRepository.transferOwnership` |
| Vaccination / treatment history (vet-signed) | `livestock.health_records` (wave L1b, migration 013) — reversal-aware summaries mirror the grading logic |
| Movement + permit legality | `livestock.movements` + `livestock.movement_permits` (wave L1b) |
| Lien status | `livestock.liens` (wave L1c, migration 014) — the active-lien transfer block mirrors `createLienTransferGuard` |
| Insurance status | `livestock.insurance_policies` (wave L1c) |

The passport itself (schema `livestock_passport`, migration 036) stores only
the anchor record, an **append-only hash-chained event log** (same scheme as
the traceability custody chain — `prev_event_hash` + sha256 over canonical
JSON, no DB triggers) and the **two-party ownership-transfer handshake**
(seller initiates → buyer confirms; both parties in audit + chain; blocked
while an active lien exists, re-checked at confirmation).

## Public verification

`GET /livestock-passport/verify/:passportCode` is **unauthenticated**. The
code (`LSP.{animalId}.{nonce}.{sig16}`) is HMAC-SHA256 signed server-side
(agent-banking voucher pattern) so forged codes fail verification with a
plain 404. The view is redacted: animal identity, vaccination summary,
movement-legality summary, encumbrance FLAGS — owner identity is initials
only, lien amounts/lender identity never leak. `qr.verifyPath` is the
QR-code-ready payload.

## RBAC

farmer (own animals, issue, initiate/cancel transfers) · vet (health reads
surface in the passport) · buyer (public verify, read passport while named
on a pending transfer, confirm) · regulator (oversight export, suspend /
reinstate) · admin (all of the above).

Mutations are idempotent via the global `Idempotency-Key` interceptor.

## External gates — NOT yet integrated

- **National animal-ID authority / RFID tag registry**: behind the
  `AnimalIdAuthorityProvider` port. Default is a deterministic, honestly
  labelled STUB (`basis:'stub'`, `STUB-NAIS-*` references). A live driver
  ships fail-closed: `ANIMAL_ID_AUTHORITY_MODE=live` (or setting
  `ANIMAL_ID_AUTHORITY_URL`) without BOTH `ANIMAL_ID_AUTHORITY_URL` and
  `ANIMAL_ID_AUTHORITY_API_KEY` aborts boot; a configured-but-unreachable
  authority answers 503 — the stub is never silently substituted. **No
  government integration exists or is claimed; onboarding the state
  veterinary authority + tag registry is an external gate** (contract +
  credentials required).
- **Lien-based transfer blocking** inherits the livestock-trade legal
  caveat: secured-transaction / collateral-registry review under Nigerian
  law (Secured Transactions in Movable Assets Act, 2017) before production
  activation.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `LIVESTOCK_PASSPORT_SECRET` | **production** | >= 16 chars; boot aborts in production without it (dev default is labelled INSECURE). |
| `ANIMAL_ID_AUTHORITY_MODE` | no | `stub` (default) or `live`. |
| `ANIMAL_ID_AUTHORITY_URL` | live mode | Base URL of the contracted authority API. |
| `ANIMAL_ID_AUTHORITY_API_KEY` | live mode | Credential for the authority API. |

See `docs/livestock-passport.md` for the full specification.
