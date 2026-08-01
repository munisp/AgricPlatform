# AgricPlatform

Unified implementation of the Nigeria Farmer Platform PRD v3.3 for NYFN.

## What is included
- Next.js role-aware PWA frontend
- NestJS modular API
- Shared domain contracts and fixtures
- Local integration stubs for SMS, WhatsApp, payments, LMS, community, weather and search
- GitHub, environment, security, and production-readiness documentation

## Quick start
```bash
npm ci
npm run validate

# Run API and web together:
npm run dev

# Or run them separately:
npm run dev -w @agric-platform/api
npm run dev -w @agric-platform/web
```

Default URLs:
- Web: http://localhost:3000
- API: http://localhost:3001
- API OpenAPI UI: http://localhost:3001/api/v1/docs

## Running the web app against the API
The Next.js PWA talks to the NestJS API directly from the browser — **no dev
proxy is needed** because CORS is configured API-side (`CORS_ORIGIN`, default
`http://localhost:3000`).

- Point the web client at an API with `NEXT_PUBLIC_API_BASE_URL` (default
  `http://localhost:3001/api/v1`, see `.env.example`).
- Authentication: production clients send `Authorization: Bearer <OIDC JWT>`.
  In development (`NODE_ENV !== 'production'` on the API) the app sends the
  `x-user-id` header of the seeded user selected in the header's dev role
  preview (e.g. `user-adamu`, `user-admin`).
- Offline-first: when the API is unreachable, screens render cached data or
  clearly-marked fixture fallbacks, and mutations are stored in the on-device
  sync queue (dashboard → "Sync queue") and replayed with idempotency keys on
  reconnect.

## Documentation
- `SPEC.md` — implementation contract
- `docs/prd-analysis.md` — PRD interpretation
- `docs/architecture.md` — architecture and data model
- `docs/github-strategy.md` — repository and operating model
- `docs/requirements-traceability.md` — PRD-to-implementation traceability
- `docs/security-compliance.md` — security controls and launch blockers
- `docs/integration-matrix.md` — provider adapter and credential matrix
- `docs/production-readiness.md` — final readiness assessment

## Container builds
- Root `Dockerfile` — all-in-one preview/validation image for the API and web app.
- `infra/docker/api.Dockerfile` and `infra/docker/web.Dockerfile` — separated production-oriented service images.
- `infra/docker-compose.yml` — local dependency and service topology.

## External credentials
The codebase boots with stub providers. Copy `.env.example` to `.env` and set production credentials only in your local or cloud secret store. Never commit real secrets.
