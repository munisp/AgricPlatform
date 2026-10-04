# Route inventory — backend routes without a frontend caller

> GENERATED FILE — regenerate with `node scripts/route-inventory.mjs`.
> Do not edit by hand; `--check` fails CI when this drifts from the code.

GAP-M22 triage: every `apps/api` controller route is cross-referenced
against static `apiFetch` caller literals in `apps/web` and
`apps/mobile`, and the routes without a caller are categorised.

## Methodology and caveats

Mechanical, string-literal analysis only:

- Routes are parsed from `@Controller(prefix)` + `@Get/@Post/@Patch/@Put/@Delete`
  decorators (the global `api/v1` prefix is omitted everywhere).
- Callers are `apiFetch('/path')` / template-literal literals in
  `apps/web/lib/**` and `apps/mobile/src/**`; `${...}` and `:param` segments
  are normalised to `{}` on both sides before matching.
- "No caller" means NO STATIC CALLER LITERAL was found — dynamically-built
  paths, gateway rewrites and non-`apiFetch` callers are invisible to this
  analysis. `dead` rows are REVIEW CANDIDATES, not proven dead code.
- Coverage signals: a same-name `*.controller.spec.ts` exists, any API
  spec/e2e source mentions the route path, or any `docs/*.md` mentions it.

Categories:

| Category | Mechanical rule |
| --- | --- |
| `partner` | `partner/*` routes; provider/telco callback ingress (`integrations/*webhook*`, `ussd/*`, `ivr/*`) |
| `admin` | `admin/*` operator routes |
| `internal` | `internal/*` service-to-service ingress |
| `mobile-only` | mobile caller literal exists, no web caller |
| `dead` | no caller AND no coverage signal — removal-review candidate |
| `future-web` | everything else without a web caller (web backlog candidates) |

## Summary

| Metric | Count |
| --- | ---: |
| Backend routes parsed | 821 |
| Routes with a web caller | 435 |
| Routes with a mobile caller only | 10 |
| Routes with no frontend caller at all | 376 |
| Routes without a web caller (categorised below) | 386 |
| …of which zero coverage signal (no spec/test/doc) | 204 |

| Category | Routes |
| --- | ---: |
| partner | 36 |
| admin | 28 |
| internal | 1 |
| future-web | 132 |
| mobile-only | 10 |
| dead | 179 |

## Routes without a web caller, by category

### partner (36)

| Method | Path | Controller | Coverage signals |
| --- | --- | --- | --- |
| POST | `/integrations/federation/webhooks/farmos` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/webhooks/lender` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/webhooks/litefarm` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/webhooks/ofn` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/webhooks/:provider` | apps/api/src/modules/integrations/integrations.controller.ts | controller-spec, doc-mention |
| POST | `/ivr/callback` | apps/api/src/modules/ivr/ivr.controller.ts | doc-mention |
| GET | `/partner/:partnerId/participants` | apps/api/src/modules/partner/partner.controller.ts | — |
| GET | `/partner/applications/count/:partnerId` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec |
| GET | `/partner/credit-passports/:userId` | apps/api/src/modules/credit-passport/credit-passport-partner.controller.ts | controller-spec |
| GET | `/partner/credit/coop-score/:cooperativeId` | apps/api/src/modules/credit/coop-score-partner.controller.ts | — |
| GET | `/partner/developer-keys` | apps/api/src/modules/partner-api/developer-keys.controller.ts | controller-spec, test-mention, doc-mention |
| POST | `/partner/developer-keys` | apps/api/src/modules/partner-api/developer-keys.controller.ts | controller-spec, test-mention, doc-mention |
| DELETE | `/partner/developer-keys/:id` | apps/api/src/modules/partner-api/developer-keys.controller.ts | controller-spec |
| POST | `/partner/disbursements` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec, test-mention |
| POST | `/partner/enrolments` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec |
| POST | `/partner/farm-data` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec |
| GET | `/partner/impact/:partnerId` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec |
| GET | `/partner/insurance/portfolio` | apps/api/src/modules/insurance/insurer-api.controller.ts | doc-mention |
| GET | `/partner/insurance/trigger-events` | apps/api/src/modules/insurance/insurer-api.controller.ts | doc-mention |
| GET | `/partner/members/:userId/profile` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec |
| POST | `/partner/oauth/token` | apps/api/src/modules/partner-api/partner-oauth.controller.ts | test-mention |
| GET | `/partner/participation/:partnerId` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec |
| GET | `/partner/portfolio/scorecard` | apps/api/src/modules/partner-api/portfolio-scorecard.controller.ts | controller-spec |
| GET | `/partner/portfolio/scorecard/export` | apps/api/src/modules/partner-api/portfolio-scorecard.controller.ts | controller-spec |
| GET | `/partner/traceability/dds/:id` | apps/api/src/modules/traceability/dds-studio-partner.controller.ts | controller-spec |
| GET | `/partner/traceability/dds/:id/export` | apps/api/src/modules/traceability/dds-studio-partner.controller.ts | controller-spec |
| POST | `/partner/traceability/dds/:id/validate` | apps/api/src/modules/traceability/dds-studio-partner.controller.ts | controller-spec |
| POST | `/partner/traceability/shipments` | apps/api/src/modules/traceability/traceability-partner.controller.ts | controller-spec, doc-mention |
| GET | `/partner/traceability/shipments/:id/dds` | apps/api/src/modules/traceability/traceability-partner.controller.ts | controller-spec, doc-mention |
| POST | `/partner/traceability/shipments/:id/dds` | apps/api/src/modules/traceability/dds-studio-partner.controller.ts | controller-spec, doc-mention |
| GET | `/partner/traceability/shipments/:id/dds/verify` | apps/api/src/modules/traceability/traceability-partner.controller.ts | controller-spec, doc-mention |
| GET | `/partner/webhooks` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec, test-mention, doc-mention |
| POST | `/partner/webhooks` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec, test-mention, doc-mention |
| DELETE | `/partner/webhooks/:id` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec, doc-mention |
| POST | `/partner/webhooks/:id/rotate-secret` | apps/api/src/modules/partner-api/partner-api.controller.ts | controller-spec, doc-mention |
| POST | `/ussd/callback` | apps/api/src/modules/ussd/ussd.controller.ts | test-mention, doc-mention |

### admin (28)

| Method | Path | Controller | Coverage signals |
| --- | --- | --- | --- |
| GET | `/admin/audit-log/anchors` | apps/api/src/modules/admin/admin.controller.ts | doc-mention |
| POST | `/admin/audit-log/anchors` | apps/api/src/modules/admin/admin.controller.ts | doc-mention |
| GET | `/admin/events` | apps/api/src/modules/admin/admin.controller.ts | — |
| GET | `/admin/fraud/alerts` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/alerts/:id/confirm` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/alerts/:id/dismiss` | apps/api/src/modules/fraud/cases.controller.ts | — |
| GET | `/admin/fraud/cases` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/cases` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/cases/:id/resolve` | apps/api/src/modules/fraud/cases.controller.ts | — |
| GET | `/admin/fraud/rules` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/rules/:code/params` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/rules/:code/toggle` | apps/api/src/modules/fraud/cases.controller.ts | — |
| POST | `/admin/fraud/sentinel/run` | apps/api/src/modules/fraud/cases.controller.ts | — |
| GET | `/admin/outbox/dead-letters` | apps/api/src/modules/admin/admin.controller.ts | test-mention |
| POST | `/admin/outbox/dead-letters/:id/redrive` | apps/api/src/modules/admin/admin.controller.ts | — |
| POST | `/admin/partner-clients` | apps/api/src/modules/admin/admin.controller.ts | test-mention, doc-mention |
| GET | `/admin/partner-memberships` | apps/api/src/modules/admin/admin.controller.ts | test-mention |
| POST | `/admin/partner-webhooks/redrive` | apps/api/src/modules/admin/admin.controller.ts | doc-mention |
| POST | `/admin/sweeps/escrow-expiry` | apps/api/src/modules/admin/admin.controller.ts | — |
| POST | `/admin/sweeps/voucher-stuck` | apps/api/src/modules/admin/admin.controller.ts | — |
| GET | `/admin/users` | apps/api/src/modules/admin/admin.controller.ts | test-mention, doc-mention |
| POST | `/admin/users` | apps/api/src/modules/admin/admin.controller.ts | test-mention, doc-mention |
| DELETE | `/admin/users/:id/partner-memberships/:partnerId` | apps/api/src/modules/admin/admin.controller.ts | — |
| PUT | `/admin/users/:id/partner-memberships/:partnerId` | apps/api/src/modules/admin/admin.controller.ts | — |
| PATCH | `/admin/users/:id/roles` | apps/api/src/modules/admin/admin.controller.ts | doc-mention |
| PATCH | `/admin/users/:id/status` | apps/api/src/modules/admin/admin.controller.ts | — |
| PATCH | `/admin/users/:id/verification` | apps/api/src/modules/admin/admin.controller.ts | — |
| POST | `/admin/webhooks/reprocess` | apps/api/src/modules/admin/admin.controller.ts | — |

### internal (1)

| Method | Path | Controller | Coverage signals |
| --- | --- | --- | --- |
| POST | `/internal/events` | apps/api/src/modules/integrations/internal-events.controller.ts | controller-spec, test-mention |

### future-web (132)

| Method | Path | Controller | Coverage signals |
| --- | --- | --- | --- |
| GET | `/` | apps/api/src/common/metrics/metrics.controller.ts | test-mention, doc-mention |
| GET | `/agent-banking/agents` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec, test-mention, doc-mention |
| POST | `/agent-banking/agents` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec, test-mention, doc-mention |
| GET | `/agent-banking/agents/:id` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec, doc-mention |
| POST | `/agent-banking/agents/:id/cash-in` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/agents/:id/cash-out` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/agents/:id/deregister` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| GET | `/agent-banking/agents/:id/devices` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/agents/:id/devices` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/agents/:id/devices/:deviceId/revoke` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| PATCH | `/agent-banking/agents/:id/limits` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| GET | `/agent-banking/agents/:id/reversals` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/agents/:id/reversals` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| GET | `/agent-banking/agents/:id/settlement` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| PATCH | `/agent-banking/agents/:id/status` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/callback` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| GET | `/agent-banking/farmers/me/transactions` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/forecast/run` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| GET | `/agent-banking/forecasts` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| POST | `/agent-banking/interop/quote` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec, doc-mention |
| GET | `/agent-banking/interop/status` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec, doc-mention |
| GET | `/agent-banking/merchant-payments/:id` | apps/api/src/modules/agent-banking/dealer-qr.controller.ts | controller-spec |
| POST | `/agent-banking/merchant-payments/:id/confirm` | apps/api/src/modules/agent-banking/dealer-qr.controller.ts | controller-spec |
| GET | `/agent-banking/merchants/:id/qr` | apps/api/src/modules/agent-banking/dealer-qr.controller.ts | controller-spec |
| POST | `/agent-banking/merchants/:id/qr` | apps/api/src/modules/agent-banking/dealer-qr.controller.ts | controller-spec |
| POST | `/agent-banking/mojaloop` | apps/api/src/modules/agent-banking/dealer-qr.controller.ts | controller-spec |
| POST | `/agent-banking/qr/:code/pay` | apps/api/src/modules/agent-banking/dealer-qr.controller.ts | controller-spec |
| GET | `/agent-banking/rebalance-alerts` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| POST | `/agent-banking/rebalance-alerts/:id/ack` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| POST | `/agent-banking/rebalance-alerts/:id/resolve` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| GET | `/agent-banking/rebalance-runs` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| POST | `/agent-banking/rebalance-runs` | apps/api/src/modules/agent-banking/float-forecast.controller.ts | controller-spec |
| POST | `/agent-banking/reversals/:id/approve` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/reversals/:id/reject` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| GET | `/agent-banking/vouchers/:id` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/vouchers/:id/confirm-refund` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/vouchers/:id/expire` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| POST | `/agent-banking/vouchers/:id/void` | apps/api/src/modules/agent-banking/agent-banking.controller.ts | controller-spec |
| GET | `/agronomist/cases` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| GET | `/agronomist/cases/:id` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| POST | `/agronomist/cases/:id/answer` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| POST | `/agronomist/cases/:id/claim` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| POST | `/agronomist/cases/:id/quality` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| GET | `/agronomist/sla-report` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| POST | `/agronomist/sla/sweep` | apps/api/src/modules/voice/console.controller.ts | controller-spec |
| GET | `/analytics/export/:fact.csv` | apps/api/src/modules/analytics/analytics.controller.ts | controller-spec, test-mention |
| GET | `/analytics/marts/:mart/export` | apps/api/src/modules/analytics/analytics.controller.ts | controller-spec |
| GET | `/analytics/overview` | apps/api/src/modules/analytics/analytics.controller.ts | controller-spec, test-mention |
| GET | `/analytics/segments` | apps/api/src/modules/analytics/analytics.controller.ts | controller-spec, test-mention |
| GET | `/applications/:id` | apps/api/src/modules/opportunities/opportunities.controller.ts | doc-mention |
| PATCH | `/applications/:id/status` | apps/api/src/modules/opportunities/opportunities.controller.ts | doc-mention |
| GET | `/audit/evidence` | apps/api/src/modules/admin/audit-evidence.controller.ts | doc-mention |
| POST | `/auth/pin-profiles` | apps/api/src/modules/auth/pin-sessions.controller.ts | doc-mention |
| GET | `/auth/pin-profiles/:deviceToken` | apps/api/src/modules/auth/pin-sessions.controller.ts | doc-mention |
| POST | `/auth/pin-sessions/switch` | apps/api/src/modules/auth/pin-sessions.controller.ts | doc-mention |
| PATCH | `/buyer-groups/:id` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| GET | `/buyer-groups/:id/members` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| POST | `/buyer-groups/:id/members` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| DELETE | `/buyer-groups/:id/members/:userId` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| POST | `/checkout/preview` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| POST | `/compliance/dsr/:id/approve` | apps/api/src/modules/compliance/compliance.controller.ts | doc-mention |
| GET | `/compliance/retention/policies` | apps/api/src/modules/compliance/compliance.controller.ts | doc-mention |
| POST | `/compliance/retention/policies` | apps/api/src/modules/compliance/compliance.controller.ts | doc-mention |
| POST | `/compliance/retention/sweep` | apps/api/src/modules/compliance/compliance.controller.ts | doc-mention |
| POST | `/draft-orders/:id/discard` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| GET | `/embed/courses` | apps/api/src/modules/embed/embed.controller.ts | test-mention |
| GET | `/embed/member-cta` | apps/api/src/modules/embed/embed.controller.ts | test-mention |
| GET | `/embed/opportunities` | apps/api/src/modules/embed/embed.controller.ts | test-mention |
| GET | `/embed/prices` | apps/api/src/modules/embed/embed.controller.ts | test-mention |
| POST | `/escrow/expire` | apps/api/src/modules/marketplace/commerce.controller.ts | doc-mention |
| GET | `/finance/ledger/accounts` | apps/api/src/modules/finance/ledger.controller.ts | test-mention |
| POST | `/finance/ledger/accounts` | apps/api/src/modules/finance/ledger.controller.ts | test-mention |
| GET | `/finance/ledger/backend-status` | apps/api/src/modules/finance/ledger.controller.ts | doc-mention |
| GET | `/finance/ledger/entries` | apps/api/src/modules/finance/ledger.controller.ts | test-mention |
| POST | `/finance/ledger/entries` | apps/api/src/modules/finance/ledger.controller.ts | test-mention |
| GET | `/health` | apps/api/src/health/health.controller.ts | controller-spec, test-mention, doc-mention |
| GET | `/health/live` | apps/api/src/health/health.controller.ts | controller-spec, doc-mention |
| GET | `/health/ready` | apps/api/src/health/health.controller.ts | controller-spec, test-mention, doc-mention |
| GET | `/input-vouchers/programmes/:id` | apps/api/src/modules/input-vouchers/input-vouchers.controller.ts | controller-spec |
| GET | `/input-vouchers/programmes/:id/funding` | apps/api/src/modules/input-vouchers/input-vouchers.controller.ts | controller-spec |
| POST | `/input-vouchers/programmes/:id/funding` | apps/api/src/modules/input-vouchers/input-vouchers.controller.ts | controller-spec |
| GET | `/input-vouchers/vouchers/:id` | apps/api/src/modules/input-vouchers/input-vouchers.controller.ts | controller-spec |
| POST | `/input-vouchers/vouchers/:id/expire` | apps/api/src/modules/input-vouchers/input-vouchers.controller.ts | controller-spec |
| POST | `/input-vouchers/vouchers/:id/refund` | apps/api/src/modules/input-vouchers/input-vouchers.controller.ts | controller-spec |
| POST | `/insurance/evaluate-triggers` | apps/api/src/modules/insurance/insurance.controller.ts | doc-mention |
| POST | `/insurance/payouts/:id/confirm` | apps/api/src/modules/insurance/insurance.controller.ts | doc-mention |
| GET | `/insurance/payouts/all` | apps/api/src/modules/insurance/insurance.controller.ts | test-mention |
| GET | `/insurance/policies/:id` | apps/api/src/modules/insurance/insurance.controller.ts | doc-mention |
| POST | `/insurance/policies/:id/expire` | apps/api/src/modules/insurance/insurance.controller.ts | doc-mention |
| GET | `/insurance/trigger-events/all` | apps/api/src/modules/insurance/insurance.controller.ts | test-mention |
| GET | `/integrations/:provider` | apps/api/src/modules/integrations/integrations.controller.ts | controller-spec |
| GET | `/integrations/:provider/health` | apps/api/src/modules/integrations/integrations.controller.ts | controller-spec |
| POST | `/integrations/bridges/:bridge/sync` | apps/api/src/modules/integrations/integrations.controller.ts | controller-spec |
| POST | `/livestock-passport/:id/reinstate` | apps/api/src/modules/livestock-passport/livestock-passport.controller.ts | controller-spec |
| POST | `/livestock-passport/:id/suspend` | apps/api/src/modules/livestock-passport/livestock-passport.controller.ts | controller-spec, doc-mention |
| GET | `/livestock-passport/authority/status` | apps/api/src/modules/livestock-passport/livestock-passport.controller.ts | controller-spec, doc-mention |
| GET | `/livestock-passport/export/oversight` | apps/api/src/modules/livestock-passport/livestock-passport.controller.ts | controller-spec, doc-mention |
| GET | `/notifications/deliveries` | apps/api/src/modules/notifications/notifications.controller.ts | test-mention |
| POST | `/notifications/send` | apps/api/src/modules/notifications/notifications.controller.ts | test-mention |
| GET | `/opportunities/:id` | apps/api/src/modules/opportunities/opportunities.controller.ts | doc-mention |
| GET | `/orders/:id/promotions` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec, test-mention |
| PATCH | `/orders/:id/status` | apps/api/src/modules/marketplace/marketplace.controller.ts | test-mention, doc-mention |
| GET | `/payments/intents/:id` | apps/api/src/modules/marketplace/commerce.controller.ts | doc-mention |
| PATCH | `/price-lists/:id` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| GET | `/price-lists/:id/entries` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| POST | `/price-lists/:id/entries` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| PATCH | `/promotions/:id` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| GET | `/search/driver-status` | apps/api/src/modules/search/search.controller.ts | controller-spec |
| GET | `/search/suggest` | apps/api/src/modules/search/search.controller.ts | controller-spec |
| GET | `/traceability/lots/:id` | apps/api/src/modules/traceability/traceability.controller.ts | doc-mention |
| GET | `/traceability/lots/:id/plots` | apps/api/src/modules/traceability/traceability.controller.ts | doc-mention |
| POST | `/traceability/lots/:id/plots` | apps/api/src/modules/traceability/traceability.controller.ts | doc-mention |
| POST | `/traceability/lots/:id/split` | apps/api/src/modules/traceability/traceability.controller.ts | doc-mention |
| POST | `/traceability/lots/aggregate` | apps/api/src/modules/traceability/traceability.controller.ts | doc-mention |
| GET | `/traceability/shipments/:id` | apps/api/src/modules/traceability/traceability.controller.ts | doc-mention |
| GET | `/users/:id` | apps/api/src/modules/users/users.controller.ts | doc-mention |
| PATCH | `/users/:id` | apps/api/src/modules/users/users.controller.ts | doc-mention |
| POST | `/users/assisted` | apps/api/src/modules/users/users.controller.ts | test-mention, doc-mention |
| PATCH | `/variants/:id` | apps/api/src/modules/commerce/commerce.controller.ts | controller-spec |
| POST | `/voice/sessions` | apps/api/src/modules/voice/voice.controller.ts | controller-spec, doc-mention |
| GET | `/voice/sessions/:id` | apps/api/src/modules/voice/voice.controller.ts | controller-spec, doc-mention |
| POST | `/voice/sessions/:id/escalate` | apps/api/src/modules/voice/voice.controller.ts | controller-spec, doc-mention |
| POST | `/voice/sessions/:id/turns` | apps/api/src/modules/voice/voice.controller.ts | controller-spec, doc-mention |
| GET | `/vsla-carbon/coefficients` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | test-mention |
| GET | `/vsla-carbon/reports/export` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | doc-mention |
| POST | `/warehouse/ltv/run` | apps/api/src/modules/warehouse/ltv-guardian.controller.ts | controller-spec |
| GET | `/warehouse/positions/:id` | apps/api/src/modules/warehouse/ltv-guardian.controller.ts | controller-spec |
| POST | `/warehouse/receipts/:id/loss` | apps/api/src/modules/warehouse/warehouse.controller.ts | controller-spec |
| POST | `/warehouse/receipts/:id/monitor` | apps/api/src/modules/warehouse/ltv-guardian.controller.ts | controller-spec |
| POST | `/warehouse/receipts/:id/split` | apps/api/src/modules/warehouse/warehouse.controller.ts | controller-spec |
| POST | `/warehouse/warehouses/:id/bond` | apps/api/src/modules/warehouse/warehouse.controller.ts | controller-spec |
| POST | `/warehouse/warehouses/:id/fraud-cases` | apps/api/src/modules/warehouse/warehouse.controller.ts | controller-spec |

### mobile-only (10)

| Method | Path | Controller | Coverage signals |
| --- | --- | --- | --- |
| GET | `/advisory/weather/:state` | apps/api/src/modules/advisory/advisory.controller.ts | — |
| POST | `/auth/logout` | apps/api/src/modules/auth/auth.controller.ts | — |
| POST | `/auth/otp/request` | apps/api/src/modules/auth/auth.controller.ts | test-mention, doc-mention |
| POST | `/auth/otp/verify` | apps/api/src/modules/auth/auth.controller.ts | test-mention, doc-mention |
| POST | `/auth/refresh` | apps/api/src/modules/auth/auth.controller.ts | — |
| GET | `/courses/:id` | apps/api/src/modules/learning/learning.controller.ts | — |
| GET | `/listings/:id` | apps/api/src/modules/marketplace/marketplace.controller.ts | — |
| PATCH | `/listings/:id` | apps/api/src/modules/marketplace/marketplace.controller.ts | — |
| POST | `/notifications/:id/read` | apps/api/src/modules/notifications/notifications.controller.ts | — |
| GET | `/orders/:id` | apps/api/src/modules/marketplace/marketplace.controller.ts | test-mention, doc-mention |

### dead (179)

| Method | Path | Controller | Coverage signals |
| --- | --- | --- | --- |
| GET | `/advisory/:id` | apps/api/src/modules/advisory/advisory.controller.ts | — |
| POST | `/advisory/dispatch/run` | apps/api/src/modules/advisory/planting-pulse.controller.ts | — |
| POST | `/advisory/price-dispatch/run` | apps/api/src/modules/advisory/price-wire.controller.ts | — |
| GET | `/advisory/price-subscriptions` | apps/api/src/modules/advisory/price-wire.controller.ts | — |
| POST | `/advisory/price-subscriptions` | apps/api/src/modules/advisory/price-wire.controller.ts | — |
| DELETE | `/advisory/price-subscriptions/:id` | apps/api/src/modules/advisory/price-wire.controller.ts | — |
| GET | `/advisory/price-subscriptions/:id/dispatches` | apps/api/src/modules/advisory/price-wire.controller.ts | — |
| GET | `/advisory/prices/:crop` | apps/api/src/modules/advisory/advisory.controller.ts | — |
| GET | `/advisory/subscriptions` | apps/api/src/modules/advisory/planting-pulse.controller.ts | — |
| POST | `/advisory/subscriptions` | apps/api/src/modules/advisory/planting-pulse.controller.ts | — |
| DELETE | `/advisory/subscriptions/:id` | apps/api/src/modules/advisory/planting-pulse.controller.ts | — |
| GET | `/advisory/subscriptions/:id/dispatches` | apps/api/src/modules/advisory/planting-pulse.controller.ts | — |
| GET | `/advisory/subscriptions/:id/next` | apps/api/src/modules/advisory/planting-pulse.controller.ts | — |
| GET | `/analytics/lender-scorecards/benchmarks/:version/:period` | apps/api/src/modules/analytics/lender-scorecard-admin.controller.ts | — |
| POST | `/analytics/lender-scorecards/publish-version` | apps/api/src/modules/analytics/lender-scorecard-admin.controller.ts | — |
| GET | `/analytics/lender-scorecards/versions` | apps/api/src/modules/analytics/lender-scorecard-admin.controller.ts | — |
| GET | `/auth/sessions` | apps/api/src/modules/auth/auth.controller.ts | — |
| GET | `/certificates/verify/:code` | apps/api/src/modules/learning/learning.controller.ts | — |
| GET | `/chapters/:id` | apps/api/src/modules/chapters/chapters.controller.ts | — |
| GET | `/chapters/:id/announcements` | apps/api/src/modules/chapters/chapters.controller.ts | — |
| POST | `/chapters/:id/announcements` | apps/api/src/modules/chapters/chapters.controller.ts | — |
| GET | `/chapters/:id/map` | apps/api/src/modules/geo-intel/chapter-map.controller.ts | — |
| POST | `/chapters/:id/map/recompute` | apps/api/src/modules/geo-intel/chapter-map.controller.ts | — |
| PATCH | `/community/mentors/requests/:id` | apps/api/src/modules/community/community.controller.ts | — |
| GET | `/community/topics/:id` | apps/api/src/modules/community/community.controller.ts | — |
| POST | `/community/topics/:id/flag` | apps/api/src/modules/community/community.controller.ts | — |
| POST | `/community/topics/:id/replies` | apps/api/src/modules/community/community.controller.ts | — |
| POST | `/compliance/dsr/:id/reject` | apps/api/src/modules/compliance/compliance.controller.ts | — |
| GET | `/credit-passport/verify/:code` | apps/api/src/modules/credit-passport/credit-passport.controller.ts | — |
| POST | `/credit/applications/:id/accept-schedule` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/approve` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/default` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/disburse` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/reject` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/restructure` | apps/api/src/modules/credit/applications.controller.ts | — |
| GET | `/credit/applications/:id/restructures` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/score` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/seasonal-schedule/preview` | apps/api/src/modules/credit/applications.controller.ts | — |
| GET | `/credit/applications/:id/seasonal-schedules` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/settle` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/start-repayment` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/submit` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/:id/write-off` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/collateral/:collateralId/claim` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/collateral/:collateralId/release` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/guarantors/:guarantorId/accept` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/guarantors/:guarantorId/decline` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/guarantors/:guarantorId/demand/accept` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/guarantors/:guarantorId/demand/settle` | apps/api/src/modules/credit/applications.controller.ts | — |
| POST | `/credit/applications/top-up` | apps/api/src/modules/credit/applications.controller.ts | — |
| GET | `/credit/coop-score/:cooperativeId` | apps/api/src/modules/credit/coop-score.controller.ts | — |
| POST | `/credit/coop-score/:cooperativeId/recompute` | apps/api/src/modules/credit/coop-score.controller.ts | — |
| GET | `/credit/groups/:id` | apps/api/src/modules/credit/groups.controller.ts | — |
| POST | `/credit/groups/:id/dissolve` | apps/api/src/modules/credit/groups.controller.ts | — |
| GET | `/credit/groups/:id/exit-settlement` | apps/api/src/modules/credit/groups.controller.ts | — |
| POST | `/credit/groups/:id/leave` | apps/api/src/modules/credit/groups.controller.ts | — |
| POST | `/credit/groups/:id/members` | apps/api/src/modules/credit/groups.controller.ts | — |
| DELETE | `/credit/groups/:id/members/:userId` | apps/api/src/modules/credit/groups.controller.ts | — |
| GET | `/credit/products/:id` | apps/api/src/modules/credit/products.controller.ts | — |
| PATCH | `/credit/products/:id` | apps/api/src/modules/credit/products.controller.ts | — |
| GET | `/credit/savings/groups/:groupId` | apps/api/src/modules/credit/savings.controller.ts | — |
| POST | `/credit/savings/groups/:groupId/deposits` | apps/api/src/modules/credit/savings.controller.ts | — |
| GET | `/credit/savings/groups/:groupId/transactions` | apps/api/src/modules/credit/savings.controller.ts | — |
| POST | `/credit/savings/groups/:groupId/withdrawals` | apps/api/src/modules/credit/savings.controller.ts | — |
| GET | `/embed/price-quote` | apps/api/src/modules/embed/embed.controller.ts | — |
| GET | `/enrolments/:id` | apps/api/src/modules/learning/learning.controller.ts | — |
| POST | `/escrow/:id/attest-delivery` | apps/api/src/modules/marketplace/delivery.controller.ts | — |
| GET | `/escrow/:id/delivery-attestations` | apps/api/src/modules/marketplace/delivery.controller.ts | — |
| POST | `/escrow/:id/resolve-split` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| PATCH | `/escrow/:id/status` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| POST | `/escrow/delivery-confirm-sweep` | apps/api/src/modules/marketplace/delivery.controller.ts | — |
| GET | `/events/:id` | apps/api/src/modules/chapters/chapters.controller.ts | — |
| GET | `/evidence/:caseType/:caseId/chain` | apps/api/src/modules/evidence/evidence.controller.ts | — |
| POST | `/evidence/:caseType/:caseId/items` | apps/api/src/modules/evidence/evidence.controller.ts | — |
| DELETE | `/evidence/:caseType/:caseId/items/:itemId` | apps/api/src/modules/evidence/evidence.controller.ts | — |
| POST | `/evidence/:caseType/:caseId/seal` | apps/api/src/modules/evidence/evidence.controller.ts | — |
| POST | `/evidence/:caseType/:caseId/uploads` | apps/api/src/modules/evidence/evidence.controller.ts | — |
| GET | `/evidence/items/:itemId/download-url` | apps/api/src/modules/evidence/evidence.controller.ts | — |
| PATCH | `/finance/documents/:id/status` | apps/api/src/modules/finance/finance.controller.ts | — |
| GET | `/finance/kyc/:userId` | apps/api/src/modules/finance/finance.controller.ts | — |
| GET | `/finance/ledger/accounts/:code/balance` | apps/api/src/modules/finance/ledger.controller.ts | — |
| GET | `/finance/ledger/accounts/:code/entries` | apps/api/src/modules/finance/ledger.controller.ts | — |
| GET | `/finance/ledger/entries/:id` | apps/api/src/modules/finance/ledger.controller.ts | — |
| POST | `/finance/ledger/entries/:id/reverse` | apps/api/src/modules/finance/ledger.controller.ts | — |
| GET | `/finance/ledger/reconciliation/backend` | apps/api/src/modules/finance/ledger.controller.ts | — |
| GET | `/finance/ledger/reconciliation/balance` | apps/api/src/modules/finance/ledger.controller.ts | — |
| GET | `/finance/ledger/reconciliation/escrow` | apps/api/src/modules/finance/ledger.controller.ts | — |
| POST | `/finance/ledger/reconciliation/escrow/repair` | apps/api/src/modules/finance/ledger.controller.ts | — |
| GET | `/finance/lender-matches/:userId` | apps/api/src/modules/finance/finance.controller.ts | — |
| POST | `/finance/loans/:id/disburse` | apps/api/src/modules/finance/loan.controller.ts | — |
| POST | `/finance/loans/:id/installments/:sequence/declare-payment` | apps/api/src/modules/finance/loan.controller.ts | — |
| PATCH | `/finance/loans/:id/status` | apps/api/src/modules/finance/loan.controller.ts | — |
| GET | `/input-vouchers/programmes/:id` | apps/api/src/modules/insurance/voucher-covers.controller.ts | — |
| GET | `/input-vouchers/programmes/:id/insurance-rider` | apps/api/src/modules/insurance/voucher-covers.controller.ts | — |
| POST | `/input-vouchers/programmes/:id/insurance-rider` | apps/api/src/modules/insurance/voucher-covers.controller.ts | — |
| POST | `/insurance/payouts/:id/appeal` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| POST | `/insurance/payouts/:id/dispute` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| POST | `/insurance/payouts/:id/reevaluate` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| POST | `/insurance/payouts/:id/reject` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| POST | `/insurance/payouts/:id/settle` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| POST | `/insurance/payouts/:id/settlement-failure` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| POST | `/insurance/payouts/ex-gratia` | apps/api/src/modules/insurance/insurance.controller.ts | — |
| GET | `/insurance/policies/:id/regen-discount` | apps/api/src/modules/insurance/regen-discount.controller.ts | — |
| GET | `/insurance/rate-card/regen` | apps/api/src/modules/insurance/regen-discount.controller.ts | — |
| POST | `/insurance/rate-card/regen` | apps/api/src/modules/insurance/regen-discount.controller.ts | — |
| POST | `/integrations/federation/exchange-feeds/pull` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/extension/pull` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/farm-records/:linkId/verification` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/import/batches` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/lender/credit-readiness` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| POST | `/integrations/federation/ofn/syndicate` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | — |
| GET | `/invoices/:id/serialised` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| PATCH | `/invoices/:id/status` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| POST | `/knowledge-resources/:id/view` | apps/api/src/modules/knowledge/knowledge.controller.ts | — |
| GET | `/livestock-compliance/export.csv` | apps/api/src/modules/livestock-trade/compliance.controller.ts | — |
| GET | `/livestock-health/recalls/mine` | apps/api/src/modules/livestock-health/livestock-health.controller.ts | — |
| GET | `/livestock/pastoralist-profile/:userId` | apps/api/src/modules/livestock/livestock.controller.ts | — |
| POST | `/marketplace/offtake-contracts` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| GET | `/marketplace/offtake-contracts/:contractId` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| GET | `/marketplace/offtake-contracts/:id` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/:id/accept` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/:id/amendments` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/:id/amendments/:amendmentId/accept` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/:id/amendments/:amendmentId/reject` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/:id/deliveries` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/settlement-sweep` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/offtake-contracts/sweep` | apps/api/src/modules/marketplace/offtake.controller.ts | — |
| POST | `/marketplace/pools` | apps/api/src/modules/marketplace/coop-pool.controller.ts | — |
| GET | `/marketplace/pools/:id` | apps/api/src/modules/marketplace/coop-pool.controller.ts | — |
| POST | `/marketplace/pools/:id/contributions` | apps/api/src/modules/marketplace/coop-pool.controller.ts | — |
| POST | `/marketplace/pools/:id/lock` | apps/api/src/modules/marketplace/coop-pool.controller.ts | — |
| POST | `/marketplace/pools/:id/settle` | apps/api/src/modules/marketplace/coop-pool.controller.ts | — |
| GET | `/me/credit-passport` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | — |
| GET | `/me/credit-passport/disclosures` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | — |
| POST | `/me/credit-passport/revoke` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | — |
| POST | `/me/credit-passport/share` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | — |
| POST | `/mechanization/bookings/:id/dispute` | apps/api/src/modules/mechanization/mechanization.controller.ts | — |
| POST | `/mechanization/bookings/:id/resolve` | apps/api/src/modules/mechanization/mechanization.controller.ts | — |
| POST | `/mechanization/bookings/auto-complete` | apps/api/src/modules/mechanization/mechanization.controller.ts | — |
| POST | `/mechanization/listings/:id/operator-verification` | apps/api/src/modules/mechanization/mechanization.controller.ts | — |
| GET | `/opportunities/recommended/:userId` | apps/api/src/modules/opportunities/opportunities.controller.ts | — |
| POST | `/orders/:id/delivery-point` | apps/api/src/modules/marketplace/delivery.controller.ts | — |
| POST | `/orders/:id/invoice` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| POST | `/orders/:id/partial-delivery` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| POST | `/orders/:id/resolve-dispute` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| GET | `/orders/:id/reviews` | apps/api/src/modules/marketplace/marketplace.controller.ts | — |
| POST | `/orders/:id/reviews` | apps/api/src/modules/marketplace/marketplace.controller.ts | — |
| POST | `/podcast-episodes/:id/transcript` | apps/api/src/modules/knowledge/knowledge.controller.ts | — |
| GET | `/privacy/delete/requests/:id` | apps/api/src/modules/privacy/privacy.controller.ts | — |
| POST | `/privacy/delete/requests/:id/confirm` | apps/api/src/modules/privacy/privacy.controller.ts | — |
| GET | `/privacy/register` | apps/api/src/modules/privacy/privacy.controller.ts | — |
| GET | `/profiles/:userId/completion` | apps/api/src/modules/profiles/profiles.controller.ts | — |
| POST | `/programme-cohorts/:id/judges` | apps/api/src/modules/programmes/programmes.controller.ts | — |
| POST | `/programme-cohorts/:id/rubric` | apps/api/src/modules/programmes/programmes.controller.ts | — |
| POST | `/programme-cohorts/:id/scores` | apps/api/src/modules/programmes/programmes.controller.ts | — |
| POST | `/programme-cohorts/:id/status` | apps/api/src/modules/programmes/programmes.controller.ts | — |
| GET | `/recommendations/similar/:type/:id` | apps/api/src/modules/search/recommendations.controller.ts | — |
| GET | `/service-offerings` | apps/api/src/modules/services-marketplace/services-marketplace.controller.ts | — |
| GET | `/service-offerings/:id` | apps/api/src/modules/services-marketplace/services-marketplace.controller.ts | — |
| POST | `/service-suppliers/:id/verification` | apps/api/src/modules/services-marketplace/services-marketplace.controller.ts | — |
| POST | `/shipments/:id/fail-refund` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| PATCH | `/shipments/:id/status` | apps/api/src/modules/marketplace/commerce.controller.ts | — |
| GET | `/traceability/dds/:id` | apps/api/src/modules/traceability/dds-studio.controller.ts | — |
| GET | `/traceability/dds/:id/export` | apps/api/src/modules/traceability/dds-studio.controller.ts | — |
| POST | `/traceability/dds/:id/validate` | apps/api/src/modules/traceability/dds-studio.controller.ts | — |
| GET | `/voice/intents/catalog` | apps/api/src/modules/voice/voice-teller.controller.ts | — |
| POST | `/vsla-carbon/cash-counts/:id/attest` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| GET | `/vsla-carbon/cycles/:id/share-out` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| GET | `/vsla-carbon/groups/:id` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| GET | `/vsla-carbon/groups/:id/cash-counts` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| POST | `/vsla-carbon/groups/:id/cash-counts` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| POST | `/vsla-carbon/groups/:id/dissolve` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| POST | `/vsla-carbon/groups/:id/exit` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| GET | `/vsla-carbon/groups/:id/meetings` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| POST | `/vsla-carbon/groups/:id/meetings` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| POST | `/vsla-carbon/loans/:id/write-off` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| GET | `/vsla-carbon/plots/:id` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | — |
| POST | `/webinars/:id/recording` | apps/api/src/modules/knowledge/knowledge.controller.ts | — |
| POST | `/webinars/:id/status` | apps/api/src/modules/knowledge/knowledge.controller.ts | — |

## Zero-coverage routes (no web caller, no spec/test/doc signal)

These are the highest-risk rows: mechanically unexercised and
undocumented. Triage: wire a client, add tests/docs, or remove.

| Method | Path | Controller | Category |
| --- | --- | --- | --- |
| GET | `/admin/events` | apps/api/src/modules/admin/admin.controller.ts | admin |
| GET | `/admin/fraud/alerts` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/alerts/:id/confirm` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/alerts/:id/dismiss` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| GET | `/admin/fraud/cases` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/cases` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/cases/:id/resolve` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| GET | `/admin/fraud/rules` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/rules/:code/params` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/rules/:code/toggle` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/fraud/sentinel/run` | apps/api/src/modules/fraud/cases.controller.ts | admin |
| POST | `/admin/outbox/dead-letters/:id/redrive` | apps/api/src/modules/admin/admin.controller.ts | admin |
| POST | `/admin/sweeps/escrow-expiry` | apps/api/src/modules/admin/admin.controller.ts | admin |
| POST | `/admin/sweeps/voucher-stuck` | apps/api/src/modules/admin/admin.controller.ts | admin |
| DELETE | `/admin/users/:id/partner-memberships/:partnerId` | apps/api/src/modules/admin/admin.controller.ts | admin |
| PUT | `/admin/users/:id/partner-memberships/:partnerId` | apps/api/src/modules/admin/admin.controller.ts | admin |
| PATCH | `/admin/users/:id/status` | apps/api/src/modules/admin/admin.controller.ts | admin |
| PATCH | `/admin/users/:id/verification` | apps/api/src/modules/admin/admin.controller.ts | admin |
| POST | `/admin/webhooks/reprocess` | apps/api/src/modules/admin/admin.controller.ts | admin |
| GET | `/advisory/:id` | apps/api/src/modules/advisory/advisory.controller.ts | dead |
| POST | `/advisory/dispatch/run` | apps/api/src/modules/advisory/planting-pulse.controller.ts | dead |
| POST | `/advisory/price-dispatch/run` | apps/api/src/modules/advisory/price-wire.controller.ts | dead |
| GET | `/advisory/price-subscriptions` | apps/api/src/modules/advisory/price-wire.controller.ts | dead |
| POST | `/advisory/price-subscriptions` | apps/api/src/modules/advisory/price-wire.controller.ts | dead |
| DELETE | `/advisory/price-subscriptions/:id` | apps/api/src/modules/advisory/price-wire.controller.ts | dead |
| GET | `/advisory/price-subscriptions/:id/dispatches` | apps/api/src/modules/advisory/price-wire.controller.ts | dead |
| GET | `/advisory/prices/:crop` | apps/api/src/modules/advisory/advisory.controller.ts | dead |
| GET | `/advisory/subscriptions` | apps/api/src/modules/advisory/planting-pulse.controller.ts | dead |
| POST | `/advisory/subscriptions` | apps/api/src/modules/advisory/planting-pulse.controller.ts | dead |
| DELETE | `/advisory/subscriptions/:id` | apps/api/src/modules/advisory/planting-pulse.controller.ts | dead |
| GET | `/advisory/subscriptions/:id/dispatches` | apps/api/src/modules/advisory/planting-pulse.controller.ts | dead |
| GET | `/advisory/subscriptions/:id/next` | apps/api/src/modules/advisory/planting-pulse.controller.ts | dead |
| GET | `/analytics/lender-scorecards/benchmarks/:version/:period` | apps/api/src/modules/analytics/lender-scorecard-admin.controller.ts | dead |
| POST | `/analytics/lender-scorecards/publish-version` | apps/api/src/modules/analytics/lender-scorecard-admin.controller.ts | dead |
| GET | `/analytics/lender-scorecards/versions` | apps/api/src/modules/analytics/lender-scorecard-admin.controller.ts | dead |
| GET | `/auth/sessions` | apps/api/src/modules/auth/auth.controller.ts | dead |
| GET | `/certificates/verify/:code` | apps/api/src/modules/learning/learning.controller.ts | dead |
| GET | `/chapters/:id` | apps/api/src/modules/chapters/chapters.controller.ts | dead |
| GET | `/chapters/:id/announcements` | apps/api/src/modules/chapters/chapters.controller.ts | dead |
| POST | `/chapters/:id/announcements` | apps/api/src/modules/chapters/chapters.controller.ts | dead |
| GET | `/chapters/:id/map` | apps/api/src/modules/geo-intel/chapter-map.controller.ts | dead |
| POST | `/chapters/:id/map/recompute` | apps/api/src/modules/geo-intel/chapter-map.controller.ts | dead |
| PATCH | `/community/mentors/requests/:id` | apps/api/src/modules/community/community.controller.ts | dead |
| GET | `/community/topics/:id` | apps/api/src/modules/community/community.controller.ts | dead |
| POST | `/community/topics/:id/flag` | apps/api/src/modules/community/community.controller.ts | dead |
| POST | `/community/topics/:id/replies` | apps/api/src/modules/community/community.controller.ts | dead |
| POST | `/compliance/dsr/:id/reject` | apps/api/src/modules/compliance/compliance.controller.ts | dead |
| GET | `/credit-passport/verify/:code` | apps/api/src/modules/credit-passport/credit-passport.controller.ts | dead |
| POST | `/credit/applications/:id/accept-schedule` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/approve` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/default` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/disburse` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/reject` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/restructure` | apps/api/src/modules/credit/applications.controller.ts | dead |
| GET | `/credit/applications/:id/restructures` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/score` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/seasonal-schedule/preview` | apps/api/src/modules/credit/applications.controller.ts | dead |
| GET | `/credit/applications/:id/seasonal-schedules` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/settle` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/start-repayment` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/submit` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/:id/write-off` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/collateral/:collateralId/claim` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/collateral/:collateralId/release` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/guarantors/:guarantorId/accept` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/guarantors/:guarantorId/decline` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/guarantors/:guarantorId/demand/accept` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/guarantors/:guarantorId/demand/settle` | apps/api/src/modules/credit/applications.controller.ts | dead |
| POST | `/credit/applications/top-up` | apps/api/src/modules/credit/applications.controller.ts | dead |
| GET | `/credit/coop-score/:cooperativeId` | apps/api/src/modules/credit/coop-score.controller.ts | dead |
| POST | `/credit/coop-score/:cooperativeId/recompute` | apps/api/src/modules/credit/coop-score.controller.ts | dead |
| GET | `/credit/groups/:id` | apps/api/src/modules/credit/groups.controller.ts | dead |
| POST | `/credit/groups/:id/dissolve` | apps/api/src/modules/credit/groups.controller.ts | dead |
| GET | `/credit/groups/:id/exit-settlement` | apps/api/src/modules/credit/groups.controller.ts | dead |
| POST | `/credit/groups/:id/leave` | apps/api/src/modules/credit/groups.controller.ts | dead |
| POST | `/credit/groups/:id/members` | apps/api/src/modules/credit/groups.controller.ts | dead |
| DELETE | `/credit/groups/:id/members/:userId` | apps/api/src/modules/credit/groups.controller.ts | dead |
| GET | `/credit/products/:id` | apps/api/src/modules/credit/products.controller.ts | dead |
| PATCH | `/credit/products/:id` | apps/api/src/modules/credit/products.controller.ts | dead |
| GET | `/credit/savings/groups/:groupId` | apps/api/src/modules/credit/savings.controller.ts | dead |
| POST | `/credit/savings/groups/:groupId/deposits` | apps/api/src/modules/credit/savings.controller.ts | dead |
| GET | `/credit/savings/groups/:groupId/transactions` | apps/api/src/modules/credit/savings.controller.ts | dead |
| POST | `/credit/savings/groups/:groupId/withdrawals` | apps/api/src/modules/credit/savings.controller.ts | dead |
| GET | `/embed/price-quote` | apps/api/src/modules/embed/embed.controller.ts | dead |
| GET | `/enrolments/:id` | apps/api/src/modules/learning/learning.controller.ts | dead |
| POST | `/escrow/:id/attest-delivery` | apps/api/src/modules/marketplace/delivery.controller.ts | dead |
| GET | `/escrow/:id/delivery-attestations` | apps/api/src/modules/marketplace/delivery.controller.ts | dead |
| POST | `/escrow/:id/resolve-split` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| PATCH | `/escrow/:id/status` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| POST | `/escrow/delivery-confirm-sweep` | apps/api/src/modules/marketplace/delivery.controller.ts | dead |
| GET | `/events/:id` | apps/api/src/modules/chapters/chapters.controller.ts | dead |
| GET | `/evidence/:caseType/:caseId/chain` | apps/api/src/modules/evidence/evidence.controller.ts | dead |
| POST | `/evidence/:caseType/:caseId/items` | apps/api/src/modules/evidence/evidence.controller.ts | dead |
| DELETE | `/evidence/:caseType/:caseId/items/:itemId` | apps/api/src/modules/evidence/evidence.controller.ts | dead |
| POST | `/evidence/:caseType/:caseId/seal` | apps/api/src/modules/evidence/evidence.controller.ts | dead |
| POST | `/evidence/:caseType/:caseId/uploads` | apps/api/src/modules/evidence/evidence.controller.ts | dead |
| GET | `/evidence/items/:itemId/download-url` | apps/api/src/modules/evidence/evidence.controller.ts | dead |
| PATCH | `/finance/documents/:id/status` | apps/api/src/modules/finance/finance.controller.ts | dead |
| GET | `/finance/kyc/:userId` | apps/api/src/modules/finance/finance.controller.ts | dead |
| GET | `/finance/ledger/accounts/:code/balance` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| GET | `/finance/ledger/accounts/:code/entries` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| GET | `/finance/ledger/entries/:id` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| POST | `/finance/ledger/entries/:id/reverse` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| GET | `/finance/ledger/reconciliation/backend` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| GET | `/finance/ledger/reconciliation/balance` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| GET | `/finance/ledger/reconciliation/escrow` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| POST | `/finance/ledger/reconciliation/escrow/repair` | apps/api/src/modules/finance/ledger.controller.ts | dead |
| GET | `/finance/lender-matches/:userId` | apps/api/src/modules/finance/finance.controller.ts | dead |
| POST | `/finance/loans/:id/disburse` | apps/api/src/modules/finance/loan.controller.ts | dead |
| POST | `/finance/loans/:id/installments/:sequence/declare-payment` | apps/api/src/modules/finance/loan.controller.ts | dead |
| PATCH | `/finance/loans/:id/status` | apps/api/src/modules/finance/loan.controller.ts | dead |
| GET | `/input-vouchers/programmes/:id` | apps/api/src/modules/insurance/voucher-covers.controller.ts | dead |
| GET | `/input-vouchers/programmes/:id/insurance-rider` | apps/api/src/modules/insurance/voucher-covers.controller.ts | dead |
| POST | `/input-vouchers/programmes/:id/insurance-rider` | apps/api/src/modules/insurance/voucher-covers.controller.ts | dead |
| POST | `/insurance/payouts/:id/appeal` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| POST | `/insurance/payouts/:id/dispute` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| POST | `/insurance/payouts/:id/reevaluate` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| POST | `/insurance/payouts/:id/reject` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| POST | `/insurance/payouts/:id/settle` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| POST | `/insurance/payouts/:id/settlement-failure` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| POST | `/insurance/payouts/ex-gratia` | apps/api/src/modules/insurance/insurance.controller.ts | dead |
| GET | `/insurance/policies/:id/regen-discount` | apps/api/src/modules/insurance/regen-discount.controller.ts | dead |
| GET | `/insurance/rate-card/regen` | apps/api/src/modules/insurance/regen-discount.controller.ts | dead |
| POST | `/insurance/rate-card/regen` | apps/api/src/modules/insurance/regen-discount.controller.ts | dead |
| POST | `/integrations/federation/exchange-feeds/pull` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | dead |
| POST | `/integrations/federation/extension/pull` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | dead |
| POST | `/integrations/federation/farm-records/:linkId/verification` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | dead |
| POST | `/integrations/federation/import/batches` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | dead |
| POST | `/integrations/federation/lender/credit-readiness` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | dead |
| POST | `/integrations/federation/ofn/syndicate` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | dead |
| POST | `/integrations/federation/webhooks/farmos` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | partner |
| POST | `/integrations/federation/webhooks/lender` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | partner |
| POST | `/integrations/federation/webhooks/litefarm` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | partner |
| POST | `/integrations/federation/webhooks/ofn` | apps/api/src/modules/integrations/phase3/phase3.controller.ts | partner |
| GET | `/invoices/:id/serialised` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| PATCH | `/invoices/:id/status` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| POST | `/knowledge-resources/:id/view` | apps/api/src/modules/knowledge/knowledge.controller.ts | dead |
| GET | `/livestock-compliance/export.csv` | apps/api/src/modules/livestock-trade/compliance.controller.ts | dead |
| GET | `/livestock-health/recalls/mine` | apps/api/src/modules/livestock-health/livestock-health.controller.ts | dead |
| GET | `/livestock/pastoralist-profile/:userId` | apps/api/src/modules/livestock/livestock.controller.ts | dead |
| POST | `/marketplace/offtake-contracts` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| GET | `/marketplace/offtake-contracts/:contractId` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| GET | `/marketplace/offtake-contracts/:id` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/:id/accept` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/:id/amendments` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/:id/amendments/:amendmentId/accept` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/:id/amendments/:amendmentId/reject` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/:id/deliveries` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/settlement-sweep` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/offtake-contracts/sweep` | apps/api/src/modules/marketplace/offtake.controller.ts | dead |
| POST | `/marketplace/pools` | apps/api/src/modules/marketplace/coop-pool.controller.ts | dead |
| GET | `/marketplace/pools/:id` | apps/api/src/modules/marketplace/coop-pool.controller.ts | dead |
| POST | `/marketplace/pools/:id/contributions` | apps/api/src/modules/marketplace/coop-pool.controller.ts | dead |
| POST | `/marketplace/pools/:id/lock` | apps/api/src/modules/marketplace/coop-pool.controller.ts | dead |
| POST | `/marketplace/pools/:id/settle` | apps/api/src/modules/marketplace/coop-pool.controller.ts | dead |
| GET | `/me/credit-passport` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | dead |
| GET | `/me/credit-passport/disclosures` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | dead |
| POST | `/me/credit-passport/revoke` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | dead |
| POST | `/me/credit-passport/share` | apps/api/src/modules/credit-passport/me-credit-passport.controller.ts | dead |
| POST | `/mechanization/bookings/:id/dispute` | apps/api/src/modules/mechanization/mechanization.controller.ts | dead |
| POST | `/mechanization/bookings/:id/resolve` | apps/api/src/modules/mechanization/mechanization.controller.ts | dead |
| POST | `/mechanization/bookings/auto-complete` | apps/api/src/modules/mechanization/mechanization.controller.ts | dead |
| POST | `/mechanization/listings/:id/operator-verification` | apps/api/src/modules/mechanization/mechanization.controller.ts | dead |
| GET | `/opportunities/recommended/:userId` | apps/api/src/modules/opportunities/opportunities.controller.ts | dead |
| POST | `/orders/:id/delivery-point` | apps/api/src/modules/marketplace/delivery.controller.ts | dead |
| POST | `/orders/:id/invoice` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| POST | `/orders/:id/partial-delivery` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| POST | `/orders/:id/resolve-dispute` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| GET | `/orders/:id/reviews` | apps/api/src/modules/marketplace/marketplace.controller.ts | dead |
| POST | `/orders/:id/reviews` | apps/api/src/modules/marketplace/marketplace.controller.ts | dead |
| GET | `/partner/:partnerId/participants` | apps/api/src/modules/partner/partner.controller.ts | partner |
| GET | `/partner/credit/coop-score/:cooperativeId` | apps/api/src/modules/credit/coop-score-partner.controller.ts | partner |
| POST | `/podcast-episodes/:id/transcript` | apps/api/src/modules/knowledge/knowledge.controller.ts | dead |
| GET | `/privacy/delete/requests/:id` | apps/api/src/modules/privacy/privacy.controller.ts | dead |
| POST | `/privacy/delete/requests/:id/confirm` | apps/api/src/modules/privacy/privacy.controller.ts | dead |
| GET | `/privacy/register` | apps/api/src/modules/privacy/privacy.controller.ts | dead |
| GET | `/profiles/:userId/completion` | apps/api/src/modules/profiles/profiles.controller.ts | dead |
| POST | `/programme-cohorts/:id/judges` | apps/api/src/modules/programmes/programmes.controller.ts | dead |
| POST | `/programme-cohorts/:id/rubric` | apps/api/src/modules/programmes/programmes.controller.ts | dead |
| POST | `/programme-cohorts/:id/scores` | apps/api/src/modules/programmes/programmes.controller.ts | dead |
| POST | `/programme-cohorts/:id/status` | apps/api/src/modules/programmes/programmes.controller.ts | dead |
| GET | `/recommendations/similar/:type/:id` | apps/api/src/modules/search/recommendations.controller.ts | dead |
| GET | `/service-offerings` | apps/api/src/modules/services-marketplace/services-marketplace.controller.ts | dead |
| GET | `/service-offerings/:id` | apps/api/src/modules/services-marketplace/services-marketplace.controller.ts | dead |
| POST | `/service-suppliers/:id/verification` | apps/api/src/modules/services-marketplace/services-marketplace.controller.ts | dead |
| POST | `/shipments/:id/fail-refund` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| PATCH | `/shipments/:id/status` | apps/api/src/modules/marketplace/commerce.controller.ts | dead |
| GET | `/traceability/dds/:id` | apps/api/src/modules/traceability/dds-studio.controller.ts | dead |
| GET | `/traceability/dds/:id/export` | apps/api/src/modules/traceability/dds-studio.controller.ts | dead |
| POST | `/traceability/dds/:id/validate` | apps/api/src/modules/traceability/dds-studio.controller.ts | dead |
| GET | `/voice/intents/catalog` | apps/api/src/modules/voice/voice-teller.controller.ts | dead |
| POST | `/vsla-carbon/cash-counts/:id/attest` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| GET | `/vsla-carbon/cycles/:id/share-out` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| GET | `/vsla-carbon/groups/:id` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| GET | `/vsla-carbon/groups/:id/cash-counts` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| POST | `/vsla-carbon/groups/:id/cash-counts` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| POST | `/vsla-carbon/groups/:id/dissolve` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| POST | `/vsla-carbon/groups/:id/exit` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| GET | `/vsla-carbon/groups/:id/meetings` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| POST | `/vsla-carbon/groups/:id/meetings` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| POST | `/vsla-carbon/loans/:id/write-off` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| GET | `/vsla-carbon/plots/:id` | apps/api/src/modules/vsla-carbon/vsla-carbon.controller.ts | dead |
| POST | `/webinars/:id/recording` | apps/api/src/modules/knowledge/knowledge.controller.ts | dead |
| POST | `/webinars/:id/status` | apps/api/src/modules/knowledge/knowledge.controller.ts | dead |
