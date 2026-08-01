# AgricPlatform Architecture

## Principles
- Phase 1 stack follows PRD Chapter 10/12: Next.js, NestJS, PostgreSQL, Redis-compatible cache, Keycloak-compatible OIDC.
- Phase 2/3 target boundaries follow Appendix A: domain ownership, event taxonomy, ACL, idempotency, workflow, ledger, and analytics separation.
- External systems are providers behind adapters. Local stubs keep CI deterministic.
- No cross-domain database access. Shared contracts live in `packages/shared`.

## Runtime topology
```text
Browser/PWA
    |
    v
Next.js web app (BFF-friendly pages)
    |
    v
NestJS modular API
    |-- Identity, profiles, consent
    |-- Learning, community, advisory
    |-- Opportunities, chapters, programmes
    |-- Marketplace, finance, notifications
    |-- Admin, partner, analytics, search
    |
    +--> PostgreSQL schema (production)
    +--> Redis idempotency/cache (production)
    +--> Keycloak OIDC
    +--> Moodle / Discourse / Directus bridges
    +--> Paystack / Termii / WhatsApp / email / push adapters
    +--> Weather, price, farm and exchange feed adapters
```

## Domain modules
- Auth: OTP-ready login contracts, sessions, role context.
- Users: members, roles, verification states.
- Profiles: progressive profiles, completion scoring, locations.
- Learning: courses, enrolments, certificates, Moodle bridge.
- Community: forums, groups, mentorship, moderation, Discourse bridge.
- Opportunities: opportunities, applications, eligibility, partner postings.
- Chapters: hierarchy, members, events, RSVP, attendance, announcements.
- Advisory: crop calendar, pest alerts, weather and price snapshots.
- Marketplace: listings, buyer requests, orders, reviews, escrow-ready state.
- Finance: credit profile, document vault, KYC tiers, ledger entries.
- Notifications: notification orchestration, preferences, delivery logs.
- Admin: user operations, review queues, audit, platform KPIs.
- Partner: scoped programmes, participants, impact reports.
- Analytics: platform metrics and exports.
- Privacy: consent, export, deletion, processing register.
- Search: cross-domain discovery and recommendation contracts.
- Integrations: provider status, webhooks, ACL adapters.

## Data model highlights
- Users and profiles with role, state, LGA, language, consent, completion score.
- Chapters in national/state/LGA/ward hierarchy with members and events.
- Courses, enrolments, certificates with verification codes.
- Opportunities, eligibility criteria, applications, programme cohorts.
- Marketplace listings, orders, order events, reviews.
- Credit profiles, documents, KYC records, lender matches.
- Notifications, preferences, delivery logs.
- Audit events and domain event outbox.
- Double-entry ledger accounts and transfers as the Phase 1 financial simplification.

## Event contract
Events use `{domain}.{entity}.{verb}`:
- `identity.user.registered`
- `profile.completion.updated`
- `learning.certificate.issued`
- `opportunity.application.submitted`
- `chapter.event.attendance_recorded`
- `marketplace.order.placed`
- `finance.credit_profile.updated`
- `notification.delivery.requested`

## Security and compliance
- JWT/OIDC-ready auth boundaries.
- RBAC roles: farmer, student, buyer, supplier, chapter_lead, partner, admin.
- Idempotency keys on retryable mutations.
- Audit log for admin and sensitive operations.
- Consent records with timestamp, purpose, source and revocation.
- Privacy export/delete requests.
- Secrets loaded from environment only.

## Scalability path
- Phase 1: Next.js + NestJS + PostgreSQL + local/stub integrations.
- Phase 2: extract high-throughput modules if needed; add Kafka-compatible event bus, Temporal workflows, TigerBeetle adapter, WhatsApp, marketplace and finance production drivers.
- Phase 3: analytics lakehouse, recommendation services, USSD, commodity exchange ACL and public SDK.
