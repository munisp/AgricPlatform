# AgricPlatform Implementation Specification

## Source and decision frame
Source PRD: Nigeria Farmer Platform PRD v3.3, Experience & Integration Edition.

Binding implementation decision: Phase 1 uses the PRD Chapter 10/12 delivery stack: Next.js, TypeScript, NestJS, PostgreSQL, Redis-compatible cache, Keycloak-compatible OIDC, open-source-first integrations. Appendix A is treated as the Phase 2/3 target architecture. Its bounded domains, event taxonomy, deferral strategy, ACL, idempotency, and ledger principles are preserved through ports and adapters.

## Product scope
AgricPlatform is a unified digital operating system for NYFN stakeholders:
- Farmer/student onboarding and progressive profiles
- Role-based dashboards
- Learning academy integration and certificates
- Community/mentorship workflows
- Opportunity directory and applications
- Chapter operations, events, attendance, announcements
- Advisory content, crop calendar, weather/price readiness
- Produce and service marketplace foundations
- Credit readiness and document vault foundations
- Notifications across in-app, SMS, WhatsApp, email, push
- Admin, partner, analytics, audit, NDPR privacy workflows
- Search, recommendations, integration readiness

## Monorepo
- `apps/web`: Next.js App Router PWA, role-aware UI, offline-friendly flows, Nigerian design language.
- `apps/api`: NestJS modular API. Modules mirror PRD domains.
- `packages/shared`: shared types, constants, domain fixtures, utility logic.
- `infra`: local stack, deployment manifests, CI/CD references.
- `docs`: PRD analysis, architecture, GitHub strategy, readiness report.
- `scripts`: validation and repository utility scripts.

## Architecture contracts
1. API modules: auth, users, profiles, dashboard, learning, community, opportunities, chapters, advisory, marketplace, finance, notifications, admin, partner, analytics, integrations, privacy, search.
2. Domain events use `{domain}.{entity}.{verb}`.
3. Every mutating route accepts an idempotency key where retries are possible.
4. External providers are adapter interfaces with local stub implementations and documented production drivers.
5. PostgreSQL is the operational source of truth. Redis is cache/idempotency. A double-entry Postgres ledger is the Phase 1 financial simplification; TigerBeetle is a later adapter.
6. Moodle, Discourse, Directus, Keycloak, Paystack, Termii, WhatsApp, NiMet/OpenMeteo, FEWS NET, farmOS and exchange systems are integration adapters, not hard-coded business logic.
7. NDPR/NDPA consent, audit, export and deletion are first-class API and UI concerns.

## Quality gates
- npm install succeeds from a clean checkout.
- TypeScript compile and production builds pass.
- Shared unit tests pass.
- Lint passes where configured.
- No secrets committed.
- README documents setup and external credentials.
- Readiness report distinguishes implemented code, sandbox-ready integrations, and external dependencies.

## GitHub strategy
Single private monorepo named `AgricPlatform` during Phase 1. Trunk-based development from `main`; short-lived feature branches; GitHub Environments for dev/staging/production; branch protection with required CI, codeowner review, linear history, no force-push; Conventional Commits; milestones R1 Alpha, R2 Beta, R3 Launch, Phase 2, Phase 3; labels by type, domain, module, phase, release, priority, gate, and status.
