# @agric-platform/api

Modular NestJS 11 API for AgricPlatform (NYFN PRD v3.3, Phase 1 stack).

## Setup

```bash
npm install                 # from the repository root (workspaces)
npm run build -w @agric-platform/shared
npm run dev -w @agric-platform/api   # watch mode on http://localhost:3001
```

Scripts: `dev` (watch), `build`, `start`, `typecheck`, `test`.

- REST prefix: `/api/v1` (health at `/api/v1/health`, `/live`, `/ready`)
- OpenAPI UI: `/api/v1/docs` (JSON at `/api/v1/docs-json`)

## Architecture

- 18 domain modules under `src/modules` mirroring SPEC.md contract 1.
- In-memory repositories behind a `Repository<T>` port
  (`src/common/in-memory.repository.ts`); swap for PostgreSQL implementations
  without changing services (SPEC contract 5).
- Domain events use the `{domain}.{entity}.{verb}` taxonomy via the in-process
  outbox (`src/core/domain-events.service.ts`); Kafka-compatible bus in Phase 2.
- Idempotency: send `Idempotency-Key` on retryable mutations; replays return
  the cached body with `Idempotent-Replay: true` (Redis-backed in production).
- Audit log (`src/core/audit.service.ts`) records admin and sensitive actions.
- Auth: Phase 1 header identity (`x-user-id`) with RBAC guards; Keycloak OIDC
  JWT verification replaces it in production. Seed users: `user-admin`,
  `user-partner`, `user-adamu` (farmer), `user-buyer`, etc.
- Integrations (`src/modules/integrations`): Termii, WhatsApp, Paystack,
  Moodle, Discourse, Directus, weather (NiMet/Open-Meteo), search
  (Meilisearch) adapters with stub/sandbox/production drivers. All drivers
  default to local stubs — no external network calls, no secrets in the repo.

## Configuration

Copy `.env.example` to `.env`. Setting a provider API key moves that adapter
from `stub` to `sandbox`; set `<PROVIDER>_DRIVER=production` explicitly for
production drivers.
