# Key rotation runbook

How to rotate every signing/verification credential the platform holds,
with zero-downtime dual-accept windows where the mechanism supports one.
Every rotation is an audited, deliberate operator action — no automatic
rotation timers exist in this codebase.

## 1. Partner webhook delivery secrets (GAP-M23)

Outbound partner webhook payloads are HMAC-SHA256 signed with the
subscription's `secret` (partners.webhook_subscriptions). Rotation keeps
deliveries verifiable while the partner updates their receiver:

1. Operator (or the partner via `POST /partner/webhooks/:id/rotate-secret`)
   requests a rotation.
2. The service generates a new secret, moves the current one to
   `secret_prev` and stamps `secret_prev_until = now() + grace` (default
   24h, clamped to a 7d maximum).
3. During the grace window every delivery is **dual-signed**:
   - `x-agric-signature` — HMAC with the NEW secret;
   - `x-agric-signature-previous` — HMAC with the OLD secret.
   The partner can verify either header while cutting over.
4. After `secret_prev_until` the previous secret is accepted nowhere and
   the next rotation overwrites both slots.
5. The new secret is returned **exactly once** in the rotation response.
   Secrets are never logged and never echoed on subscription reads.

The dual-accept is TIME-GATED at delivery; there is no way to extend a
lapsed grace window except rotating back explicitly.

## 2. API access JWT signing (OIDC / Keycloak)

Access-token verification uses the realm's JWKS from Keycloak
(`KEYCLOAK_URL` / realm `agric-platform`). Rotation is a Keycloak-side
operation: generate the new realm key in the Keycloak admin console;
tokens signed with the previous key stay verifiable until they expire
(max access-token TTL is minutes), because the JWKS endpoint serves both
keys during the rollover. No API redeploy is needed — the verifier
refreshes JWKS on kid miss.

## 3. Agent voucher HMAC secret (AGENT_VOUCHER_SECRET)

`AGENT_VOUCHER_SECRET` signs offline vouchers (docs/agent-banking.md).
There is NO dual-accept window for voucher signatures (a voucher is a
short-lived physical artefact; agents re-issue after rotation):

1. Announce the rotation to agents (vouchers issued before the cutover will
   fail verification afterwards — redeem outstanding vouchers first).
2. Update the secret in the environment / secret store.
3. Rolling-restart the API so all replicas pick up the new value
   (`kubectl -n agric-platform rollout restart deploy/api`).
4. Verify one freshly issued voucher redeems.

## 4. AT callback token (AT_CALLBACK_TOKEN)

Africa's Talking USSD/IVR callbacks authenticate with a shared secret
(`?token=` query param or `x-at-callback-token` header):

1. Update `AT_CALLBACK_TOKEN` in the secret store and restart the API.
2. Update the callback URL / header config in the AT dashboard to match.
3. The window between (1) and (2) rejects callbacks with 401 — schedule
   the change during a low-traffic window; AT retries failed callbacks.

## 5. Provider API keys (Termii, 360dialog, Mailgun, OneSignal, Paystack, …)

All provider credentials live in `agric-secrets`
(infra/k8s/secrets-provisioning.md):

1. Create the new key at the provider.
2. Update the secret value (External Secrets / sealed-secrets / manual).
3. Rolling-restart the API; revoke the old key at the provider only after
   health checks pass.

## 6. Payment webhook verification (Paystack secret / Flutterwave verif-hash)

Rotating these breaks signature verification for in-flight webhooks:

1. Configure the new secret at the provider AND in `agric-secrets`
   (`PAYSTACK_SECRET_KEY` / the Flutterwave verif-hash).
2. Restart the API. Unverified webhooks are rejected (never processed), so
   a missed event must be re-driven via
   `POST /admin/webhooks/reprocess` after the new secret is live.

## Evidence

Every rotation-touching endpoint (webhook rotate-secret, admin secret
endpoints) writes an audit event; voucher verification failures and AT
callback 401s are logged with reason codes. Rotation drills belong to the
quarterly ops review.
