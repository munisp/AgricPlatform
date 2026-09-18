# Key rotation — platform capability (V-26)

Status: **mechanism shipped + one reference adoption** (agent-banking
vouchers). Per-module adoption is a follow-on wave; this document is the
checklist each module follows. Companion incident entry: see
`docs/runbooks/ops.md` → "Secret compromise / key rotation".

## The mechanism (`apps/api/src/common/crypto/key-rotation.ts`)

A **key ring**: one ACTIVE key (signs/hashes everything new) plus a
PREVIOUS acceptance window (verify-only). Signed payloads carry the key id
in the envelope: `<kid>:<hmac-hex>`. Verification accepts active + previous
kids and **rejects retired kids with a distinct reason**
(`retired-kid` vs `mismatch` vs `malformed`) so rotation drift is
distinguishable from tampering in logs/alerts.

Env convention per purpose `X`:

```
X_KEYS="2026-06-a=<secretA>,2025-12-b=<secretB>"   # first pair = ACTIVE, rest = PREVIOUS
X_SECRET="<secretA>"                               # legacy single-secret fallback (kid 'legacy')
```

Secrets must be base64url/base64/hex (`,` and `=` are separators). kids are
public ids (`[a-zA-Z0-9._-]{1,64}`) — never put secret material in a kid.

`resolveHmacKeyRing(env, {...})` fails closed in production: no key
material configured → boot error; any ring secret equal to a published dev
default or below the strength floor → boot error (checked for EVERY slot,
active and previous).

**Rotation procedure (any module):**
1. Generate the new secret; add `X_KEYS="<newKid>=<newSecret>,<oldKid>=<oldSecret>"`.
2. Deploy. New artifacts are signed with `<newKid>`; artifacts signed with
   `<oldKid>` keep verifying (mode `previous`).
3. After the field lifetime of the old artifacts has passed (voucher
   expiry horizon, QR re-issue cycle, …), remove the old pair and deploy
   again. Old signatures now reject with reason `retired-kid` — expected.

## Reference implementation: agent-banking vouchers (DONE)

Files: `modules/agent-banking/voucher-crypto.ts`
(`resolveVoucherKeyRing`, `signVoucherEnvelope`, `verifyVoucherEnvelope`),
adopted end-to-end in `agent-banking.service.ts` (issue + redeem) and
`dealer-qr.service.ts` (voucher tender verification).

- Issued signatures are `dev:<hex>` in dev / `<kid>:<hex>` in production.
- **Legacy window:** bare-hex signatures printed before envelopes shipped
  keep verifying against every ring secret (`legacyBareHex: true`). Drop
  the option once all fielded vouchers carry kids.
- Tests: `common/crypto/key-rotation.spec.ts` (kid window, retired
  rejection, dual-salt), plus voucher-service specs for envelope issuance
  and legacy acceptance.

## Adoption checklist (per module)

For each consumer below: (1) add a `resolve<KeyRing>` next to the existing
`resolve<Secret>`; (2) switch sign → `hmacSign(ring, …)` (envelope) and
verify → `hmacVerify(ring, …)`; (3) decide the legacy acceptance window
for already-fielded artifacts; (4) add env vars to deploy secrets;
(5) extend the module spec with: sign with kid=A → verify accepts A+B
during window → rejects retired C.

- [ ] **qr-crypto.ts** (`AGENT_QR_SECRET`, agent QR codes, sign at
  ~qr-crypto.ts:86-101). Same shape as vouchers. Legacy: fielded printed
  QRs are bare-hex → enable `legacyBareHex` until re-issuance cycle
  completes.
- [ ] **passport-code.ts** (livestock passport codes, sign at
  passport-code.ts:126-139). Legacy window: passports already issued.
- [ ] **partner-api.config.ts** (`PARTNER_API_HMAC_SECRET`, webhook
  signature verification at :40/:74). Inbound verification only — rotation
  window = partner cutover window; alert on `retired-kid` verification
  failures (a partner still on the retired secret).
- [ ] **nin-crypto.ts** (`NIN_HASH_SALT`, keyed hash at :56-72) —
  **dual-salt lookup**: use `matchKeyedHash(ring, 'nin:v1:'+nin, stored)`
  + `keyedHash(ring, …)` for writes. Stored hashes carry no kid; verify
  computes candidates under active+previous salts (constant-time).
  **Re-hash "job" design:** batch re-hash is impossible BY DESIGN (the
  plaintext NIN is never persisted). Instead: opportunistic re-hash — when
  `matchKeyedHash` returns `needsRehash: true` (matched a previous salt),
  immediately persist `keyedHash(active, …)` for that row in the same
  request. Dormant rows age out of the window when it closes; plan the
  window ≥ the beneficiary-verification re-check cadence. Dedupe invariant
  holds throughout: a NIN always maps to the same stored hash for the salt
  that wrote it, and transition rows converge to the active salt on first
  presentation.
- [ ] **msisdn-crypto.ts** (voice console phone hashing :17/:23/:48) —
  same dual-salt pattern as NIN.
- [ ] **Webhook-subscription secrets** (`webhook_subscriptions.secret`
  plaintext at `infra/postgres/010_partner_api.sql:46`, reads at
  partner-api.pg-repository.ts:116/:127). Two changes:
  1. *Encrypt at rest*: the codebase currently has NO field-encryption
     infrastructure (no AES/HSM wrapper exists — verified by absence of any
     `createCipheriv` usage), so this step must introduce one (envelope
     encryption with a master key from the secret manager) or move webhook
     secrets into the secret store with read-on-demand. Plaintext at rest
     defeats the signing upgrade entirely — a DB read yields every signing
     secret. NOTE: hashing is NOT an option here (unlike NIN) because the
     API needs the plaintext to sign outbound deliveries.
  2. *Rotate endpoint design*: `POST /partner-api/webhook-subscriptions/:id/rotate-secret`
     (admin/partner-owner authz, audited). New columns:
     `secret_prev TEXT` (encrypted) + `secret_prev_until TIMESTAMPTZ`.
     Rotation writes current→`secret_prev` with a grace TTL (default 24h,
     ≤7d) and generates a fresh current secret. During grace, outbound
     deliveries carry BOTH `X-Webhook-Signature` (new) and
     `X-Webhook-Signature-Previous` (old) headers so partners cut over
     without dropped events; a sweeper clears `secret_prev` at
     `secret_prev_until`. Never log either secret; response returns the new
     secret exactly once (creation-time-only visibility).

## Operational notes

- kid format recommendation: `<yyyymm>-<letter>` (e.g. `2026-06-a`).
- Keep the previous window SHORT (one key deep) — every previous slot is a
  verification oracle for old artifacts and must meet production strength.
- Verification failures with reason `retired-kid` after a rotation are a
  signal that a client/partner is still presenting old artifacts —
  investigate before assuming attack.
