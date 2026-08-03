# NDPA Data Inventory (Record of Processing Activities draft)

> **Template prepared for qualified Nigerian legal review — not legal advice, not reviewed, not signed off.**
> A qualified Nigerian lawyer / Data Protection Officer (DPO) must validate every row against
> the Nigeria Data Protection Act 2023 (NDPA) and NDPC guidance before this inventory is relied
> upon. Lawful-basis and retention columns are engineering defaults, not legal conclusions.

Purpose: NDPA s.29-style record of processing, mapping each personal-data category to the
database tables that hold it, the processing purpose, the candidate lawful basis, and the
retention rule enforced (or enforceable) by code.

## Inventory

| Data category | Tables (schema.table) | Purpose | Candidate lawful basis (NDPA s.25) | Retention |
|---|---|---|---|---|
| Identity (name, phone, email, language, roles) | `identity.users`, `identity.user_roles` | Membership, authentication, RBAC | Contract performance | Membership lifetime + 2 years (TEMPLATE) |
| Profile (location, farm size, interests) | `profiles.member_profiles` | Personalisation, chapter matching | Consent / legitimate interest | Membership lifetime (TEMPLATE) |
| Consent decisions (legacy) | `privacy.consent_records` | Proof of consent (NDPR/NDPA) | Legal obligation | TEMPLATE — align with compliance schedule |
| Consent decisions (versioned, Wave COMP) | `compliance.consent_records` | Proof of consent incl. policy version | Legal obligation | 730 days after revocation, then pseudonymised by the retention sweeper |
| Data-subject requests | `compliance.data_subject_requests` | NDPA s.37/s.38 workflow evidence | Legal obligation | 1095 days after closure, then pseudonymised |
| Deletion requests (legacy) | `privacy.data_requests` | Erasure workflow evidence | Legal obligation | TEMPLATE — align with DSR schedule |
| Learning (enrolments, certificates) | `learning.enrolments`, `learning.certificates` | Training delivery, certificate verification | Contract performance | 7 years for certificate verification (TEMPLATE) |
| Marketplace listings | `marketplace.listings` | Produce/equipment sales | Contract performance | TEMPLATE |
| Orders, order extensions, returns | `marketplace.orders`, `marketplace.order_extensions`, `marketplace.return_requests` | Transaction processing | Contract performance; legal obligation (financial records) | 7 years — **legal hold: never erased, see erasure policy** |
| Escrow, invoices, shipments | `marketplace.escrow_records`, `marketplace.invoices`, `marketplace.shipments` | Payment protection, delivery | Contract performance; legal obligation | 7 years — legal hold (TEMPLATE, counsel to confirm CBN/PSB duties) |
| Ledger accounts/entries, loans, repayments | `finance.ledger_accounts`, `finance.ledger_entries`, `finance.loan_applications`, `finance.repayment_schedules` | Credit readiness, lending | Contract performance; legal obligation | 7 years — legal hold (TEMPLATE) |
| Notifications + delivery logs | `notifications.notifications`, `notifications.delivery_logs` | Service messaging | Consent | 365 days, then hard-purged by the retention sweeper |
| Livestock registry (animals, lots, transfers) | `livestock.animals`, `livestock.lots`, `livestock.ownership_transfers` | Traceability (ALTP) | Contract performance; legal obligation (movement permits) | TEMPLATE — movement-permit records may have statutory retention |
| Health records, movement permits, recalls | `livestock.health_records`, `livestock.movements`, `livestock.movement_permits`, `livestock.recalls` | Disease control, recall | Legal obligation / vital interest (TEMPLATE) | TEMPLATE |
| Audit events (hash-chained) | `admin.audit_events` | Accountability, tamper evidence (NDPA security safeguards) | Legal obligation; legitimate interest | Indefinite — integrity of the chain is a security control |
| Refresh sessions | `identity.auth_sessions` | Authentication security | Contract performance; legitimate interest | Until logout/revocation; revoked on suspension and erasure |
| Outbox + inbound integration events | `events.outbox`, `integrations.inbound_events` | Reliable integration | Legitimate interest | TEMPLATE |

## Notes for the reviewer

1. **Data-controller registration**: the platform operator likely qualifies as a data controller
   of major importance under NDPA; NDPC registration is a human/legal action — see
   `legal-review-checklist.md`.
2. **Erasure semantics**: erasure (NDPA s.38) is implemented as *anonymisation* of the identity
   record; financial, audit and consent rows survive under legal hold (code pointer:
   `apps/api/src/modules/compliance/compliance.service.ts → approve()`).
3. **Cross-border transfers**: Keycloak OIDC, payment providers and WhatsApp delivery may
   involve transfers outside Nigeria — adequacy/safeguards analysis is outstanding (human).
4. Every "TEMPLATE" cell above is a placeholder pending the DPO's retention schedule.
