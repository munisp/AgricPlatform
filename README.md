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

## Documentation
- `SPEC.md` — implementation contract
- `docs/prd-analysis.md` — PRD interpretation
- `docs/architecture.md` — architecture and data model
- `docs/github-strategy.md` — repository and operating model
- `docs/requirements-traceability.md` — PRD-to-implementation traceability
- `docs/security-compliance.md` — security controls and launch blockers
- `docs/integration-matrix.md` — provider adapter and credential matrix
- `docs/production-readiness.md` — final readiness assessment

## External credentials
The codebase boots with stub providers. Copy `.env.example` to `.env` and set production credentials only in your local or cloud secret store. Never commit real secrets.
