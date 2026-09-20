# Stakeholder Onboarding

This document describes how each stakeholder role gets onto the platform and
the controls that govern every path. It reflects the code as of the
onboarding-hardening audit (OB register); it is descriptive, not aspirational.

## Roles

`USER_ROLES` (packages/shared/src/domain.ts) defines 16 roles:

- **Self-registration** (`SELF_REGISTRATION_ROLES`): `farmer`, `student`,
  `buyer`, `supplier`. These may self-register via web (`/auth/register`),
  mobile, or USSD.
- **Privileged** (granted, never self-selected): `chapter_lead`, `partner`,
  `admin`, `vet`, `lender`, `insurer`, `regulator`, `donor`, `enumerator`,
  `agronomist`, `agent`, `supervisor`. Granted by an admin via
  `PATCH /admin/users/:id/roles` or by `POST /admin/users` provisioning.

## Self-registration path (farmer / student / buyer / supplier)

1. `POST /auth/register` validates E.164 phone format, creates the account
   **unverified** (`isVerified=false`, `kycTier=tier_0`), and returns
   `{ user, otpRequestId }` — **no tokens are issued at registration** (OB-01).
   Re-registering an existing unverified phone self-heals by reissuing an OTP
   challenge instead of leaking account existence.
2. The client completes `POST /auth/otp/verify` with the OTP; only then is the
   account marked verified and a session issued. OTP requests, verifications,
   and failures (with reason codes) are audit-recorded (OB-03).
3. USSD registration (telco channel) treats line possession as proof and marks
   the account verified at creation; it is rate-limited by a shared
   (Redis-backed) counter that **fails closed** when the counter store is
   unavailable (OB-09).
4. Web and mobile role pickers offer only `SELF_REGISTRATION_ROLES` (OB-10,
   OB-18); the API rejects privileged roles on this path regardless.

## Privileged-role grants

- `PATCH /admin/users/:id/roles` (admin only) rejects granting any privileged
  role to a target that is not both `active` and `isVerified === true` (OB-07).
- `POST /admin/users` (admin only) provisions an account directly with any
  roles; the account is created unverified and the user completes OTP
  verification on first login. The action is audit-recorded (OB-17).
- `POST /admin/partner-clients` registers a partner OAuth client (secret shown
  once) for partner API access.
- Agents onboard via `POST /agent-banking/agents` (PENDING). Ledger accounts
  and the agent record are created in a single transaction (OB-12). The
  `agent` role is granted atomically when the agent transitions to ACTIVE
  (OB-05).
- Developer API keys (`POST /partner-api/developer-keys`) are restricted to
  `admin` and `partner`, and requested scopes are validated against the
  `PARTNER_API_SCOPES` whitelist derived from the scopes routes actually
  consume (OB-08).

## Session and lifecycle gates

- Session issuance (`session.issue`) rejects `suspended` and `deceased`
  accounts (OB-06); the roles guard blocks `deceased` principals separately,
  so estate-frozen accounts cannot act.
- VSLA group leadership (any role other than plain `member`) requires a
  verified identity or a non-`tier_0` KYC tier; membership itself stays open
  (OB-14). The check fails closed if the user directory is not wired.
- PIN enrollment enforces the device-token length floor on all paths (OB-16).
- The seed CLI refuses to run when `NODE_ENV=production` (OB-13).

## Assisted / guardian onboarding

`POST /users/assisted` (roles `agent`, `admin`) registers a phone-less or
guardian-dependent user with a presence proof. The user row and guardian link
are written atomically — a link-write failure leaves no orphaned identity
(OB-04).

## Identity-provider parity

The Keycloak realm (`infra/keycloak/realm-agricplatform.json`) defines all 16
roles so SSO-issued tokens carry the same role vocabulary as the API.

## Known external dependency

OB-15 (NIN/government-ID verification at KYC tier upgrades) depends on an
external identity provider integration and is documented as a candidate gate,
not built in this codebase.
