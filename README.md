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
npm install
npm run build
npm run test
npm run dev
```

Default URLs:
- Web: http://localhost:3000
- API: http://localhost:3001

## Documentation
- `SPEC.md` — implementation contract
- `docs/prd-analysis.md` — PRD interpretation
- `docs/architecture.md` — architecture and data model
- `docs/github-strategy.md` — repository and operating model
- `docs/production-readiness.md` — final readiness assessment

## External credentials
The codebase boots with stub providers. Copy `.env.example` to `.env` and set production credentials only in your local or cloud secret store. Never commit real secrets.
