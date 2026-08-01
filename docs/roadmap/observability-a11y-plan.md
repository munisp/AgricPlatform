# Observability (API) + Accessibility/i18n (Web) — Implementation Plan

> Status: approved plan, ready for coder handoff. Two independent workstreams:
> **A = API observability** (sequence after the persistence wave — shares bootstrap/
> app.module/core files), **B = web accessibility + i18n foundations** (sequence after
> the frontend API-wiring wave — shares layout/nav/app-state files).

## 0. Verified current state

**API (NestJS 11, ESM, global prefix `api/v1`):**
- `src/bootstrap.ts` — registers helmet, CORS, global `ValidationPipe`, `ApiExceptionFilter`, `RequestLoggingInterceptor`, `IdempotencyInterceptor`, Swagger at `/api/v1/docs`. `configureApp()` is shared with e2e tests — any global added there is automatically tested.
- `common/filters/api-exception.filter.ts` — envelope `{statusCode, error, message, path, timestamp}`; no `requestId`, no Sentry hook, non-HTTP exceptions logged via Nest `Logger` (unstructured).
- `common/interceptors/request-logging.interceptor.ts` — single unstructured line via `Logger('HTTP')`; no request-id, no redaction.
- `health/health.controller.ts` — `/health`, `/health/live`, `/health/ready`; readiness checks only integration adapters. (Persistence wave adds DB/Redis indicators — coordinate.)
- `core/audit.service.ts` — in-memory `AuditEvent[]`, called by admin/privacy. Not tamper-evident. `CoreModule` is `@Global()` — ideal host for cross-cutting providers.
- Domain events already exist for OTP, orders, privacy, admin — natural metric-instrumentation points.

**Web (Next.js 16 App Router, React 19, no test infra, no i18n lib):**
- `app/layout.tsx` — already has skip-link (`.skip-link` → `#main-content`), `<main>`, `<html lang="en-NG">`, manifest + viewport. Landmarks present (`components/nav.tsx`, `footer.tsx`).
- Forms well-labelled via `components/forms.tsx` `Field`. Chips use `aria-pressed`. `ProgressBar` has correct `role="progressbar"`. No modals/drawers → no keyboard traps today.
- **Measured failures (computed, not guessed):**
  - Touch targets: `.btn-small` 36px, `.chip` 38px, `.nav-links a` 40px — below the 44px floor for farmer mobile use (`.btn` 44px and `.bottom-nav a` 52px pass).
  - Contrast: `.badge-info` `#8a6d4b` on `#ece5d2` = 3.82:1 (fails AA 4.5) at 0.75rem; `.badge-critical` 4.51:1 and `--ink-mute` on `--sand-100` 4.53:1 — marginal, darken for margin; `--amber-500` 2.54:1 but only decorative.
  - `components/nav.tsx`: visually-hidden label via inline `position:absolute; left:-9999px` — should become a reusable `.sr-only` class.
  - `layout.tsx`: skip-link target `<main>` needs `tabIndex={-1}` for reliable focus.
  - `globals.css` `prefers-reduced-motion` block misses `.btn`/`.chip`/card hover transitions.
  - `components/opportunity-browser.tsx`: filter group has no `role="group"`/`<fieldset>`; result count `role="status"` present (add explicit `aria-live="polite"`); 20 identical "Apply" buttons need per-card `aria-label`.
- **PWA:** `public/sw.js` — network-first navigations w/ offline fallback to `/offline`, cache-first static; unconditional `skipWaiting()` + `clients.claim()`; no cache size cap/eviction (low-storage Android risk); no update-notification flow; VERSION is a manual constant. `next.config.ts` sets correct headers on `/sw.js`. Manifest has only SVG icons — PNG 192/512 missing (installability risk).
- **i18n hooks already present:** `shared` defines `LANGUAGE_CODES = ['en','ha','yo','ig']`, `User.preferredLanguage`; onboarding captures a language. All UI copy hardcoded English.

---

# WORKSTREAM A — Observability (API)

## A.1 Dependencies (add to `apps/api/package.json`)

| Package | Version | Peer check |
|---|---|---|
| `nestjs-pino` | `^4.6.1` | supports `@nestjs/common ^11` |
| `pino` | `^10.3.1` | — |
| `pino-http` | `^11.0.0` | — |
| `@willsoto/nestjs-prometheus` | `^6.1.0` | supports Nest ^11 + prom-client ^15 |
| `prom-client` | `^15.1.3` | — |
| `@sentry/nestjs` | `^10.69.0` | optional; lazy-loaded, env-gated |

Do NOT add `@nestjs/terminus` — peer tree drags optional ORM/grpc deps; lightweight custom indicators are cheaper.

**Logging choice: nestjs-pino** — Nest 11 peer-compatible; pino is the fastest mainstream Node logger; `pino-http` gives mature request-id + redaction machinery (~100 lines of our code); `bufferLogs` integrates with Nest DI.

## A.2 Structured logging + request-id

Create `apps/api/src/common/logging/logging.module.ts` + `redaction.ts`:

```ts
// sketch
LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    genReqId: (req, res) => {
      const id = (req.headers['x-request-id'] as string) || randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
        'req.body.code', 'req.body.devCode', 'req.body.token', 'req.body.phone',
        'res.body.token', 'res.body.devCode', 'res.body.user.phone'
      ],
      censor: '[redacted]'
    },
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, requestId: req.id,
        phone: maskPhone(req.query?.phone as string | undefined) }),
      res: (res) => ({ statusCode: res.statusCode })
    },
    autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false }
  }
})

export const maskPhone = (p?: string) =>
  p ? p.replace(/^(\d{4})\d+(\d{3})$/, '$1****$2') : undefined;
```

Modify: `app.module.ts` (import LoggingModule first), `main.ts` (`bufferLogs: true` + `app.useLogger(...)` gated off in test), `request-logging.interceptor.ts` (replace with metrics interceptor, A.3), `api-exception.filter.ts` (add `requestId` to envelope; 5xx at error with `err` object, 4xx at warn; Sentry hook).

Redaction rules (unit-tested): never log `code`/`devCode`/`token`/`authorization`/`cookie`; phone masked `0803****000`; financial payloads — log IDs and status transitions only, never full webhook payloads.

## A.3 Metrics

`@willsoto/nestjs-prometheus` + `prom-client`. Create `apps/api/src/common/metrics/metrics.module.ts`:

```ts
// sketch
PrometheusModule.register({
  path: '/metrics',            // under global prefix → /api/v1/metrics — verify with e2e
  defaultMetrics: { enabled: true },
  defaultLabels: { service: 'agric-api' }
})
// providers: http_request_duration_seconds histogram (method/route/status),
// http_requests_total counter, plus domain counters:
// agric_otp_requests_total{channel}, agric_otp_verifications_total{result},
// agric_orders_created_total{escrow}, agric_payments_total{event},
// agric_idempotent_replays_total, agric_errors_5xx_total
```

Replace `RequestLoggingInterceptor` with `HttpMetricsInterceptor` (same `useGlobalInterceptors` slot in bootstrap):

```ts
// sketch — route label cardinality is the trap
const route = (req.route?.path as string) ?? 'unmatched';  // NEVER originalUrl
const labels = { method: req.method, route, status: String(status) };
this.counter.inc(labels);
this.histogram.observe(labels, elapsedSeconds);
```

Domain counter wiring: `auth.service.ts` (OTP request/verify results), `marketplace.service.ts` (orders created; payments initiated/confirmed on status transitions), `integrations.controller.ts` (payment webhook events), `idempotency.interceptor.ts` (replays). e2e: `GET /api/v1/metrics` 200 + contains `http_requests_total`.

## A.4 Error tracking + Sentry

- Exception filter: `requestId` in envelope (propose additive `ApiErrorResponse` in `packages/shared/src/domain.ts` — coordinate; optional fields keep it non-breaking).
- Create `common/error-tracking/error-tracking.service.ts`: env-gated Sentry wrapper; **no DSN = fully disabled**; dynamic `import('@sentry/nestjs')` so it's never loaded without a DSN; `beforeSend` scrubbing (headers, phone, OTP fields); `capture5xx` only for status ≥ 500.
- 5xx alerting hook: `agric_errors_5xx_total` counter in the filter — alerting via Prometheus/Alertmanager (runbook note), keeping alert routing out of app code.

## A.5 Health/readiness

Coordinate with the persistence wave (it adds `persistence` indicators). This wave generalizes: `DependencyIndicator { name; configured(): boolean; check(): Promise<void> }` registry; `/health/ready` response gains `dependencies: [{name, status: 'up'|'down'|'skipped', latencyMs}]`; `degraded` if any configured dependency is down; `skipped` never affects status. Lazy driver imports only when env URL exists.

## A.6 Tamper-evident audit trail

Modify `core/audit.service.ts` (keep public API stable):
- Extend record: `{ ...existing, prevHash: string, hash: string, requestId?: string }`, `hash = sha256(canonicalJSON(eventWithoutHash) + prevHash)`; genesis `prevHash = '0'.repeat(64)`.
- `verify(): { valid: boolean; brokenAt?: string }` walking the chain.
- Expose via admin: `GET /api/v1/admin/audit-log/verify`.
- Shared contract: optional `prevHash`/`hash` on `AuditEvent` (additive, non-breaking).
- Add `audit.record` to `marketplace.setOrderStatus` for transitions to/from `deposit_paid`/`completed` (payment status changes). Role changes + privacy export/delete already record.
- Unit test: tamper with `events[1].metadata` → `verify()` reports `brokenAt`.
- Note: persistence wave moves audit storage behind `AUDIT_REPOSITORY` — the hash fields ride along; sequence this workstream AFTER persistence to avoid double migration.

## A.7 Ordered task list — Coder Agent A

1. Deps (A.1); build green.
2. LoggingModule + redaction + `useLogger`/`bufferLogs`; unit tests.
3. MetricsModule + HttpMetricsInterceptor; e2e `/metrics` assertion.
4. Domain counters (auth/marketplace/integrations/idempotency).
5. Exception filter: requestId + 5xx counter + ErrorTrackingService.
6. Health indicator registry (merge with persistence-wave persistence block).
7. Audit hash-chain + verify endpoint + payment-status audit records (shared-package additive edits).
8. `npm run validate`; add `docs/runbooks/observability.md`.

**Risks:** pino-pretty dev-only (`LOG_PRETTY=1` opt-in; worker threads break under watch mode). Route-label cardinality — test asserts `req.route.path`. `/metrics` lands under `api/v1` prefix — verify, don't assume. Shared-package edits are the cross-wave conflict surface.

---

# WORKSTREAM B — Accessibility + i18n foundations (Web)

## B.1 Dependencies (all devDependencies, `apps/web/package.json`)

| Package | Version | Notes |
|---|---|---|
| `eslint-plugin-jsx-a11y` | `^6.10.2` | verify what `eslint-config-next` 16 already bundles first (`npx eslint --print-config app/layout.tsx \| grep jsx-a11y`); enable gap rules only |
| `vitest` | `^3.2.4` | match root major — one vitest version across workspaces |
| `@vitejs/plugin-react` | `^6.0.5` | JSX in vitest |
| `@testing-library/react` | `^16.3.2` | React 19 compatible |
| `@testing-library/dom` | `^10.4.1` | peer |
| `jest-axe` | `^11.0.0` | vitest-compatible |
| `jsdom` | `^30.0.1` | test env |

**i18n choice: lightweight custom dictionary, NOT next-intl — for now.** next-intl 4.13.4 is Next-16 compatible and remains the migration target, but foundations-only avoids a `[locale]` route restructure of all pages against a moving codebase. The custom approach (~150 lines) preserves static rendering + standalone PWA build, and dictionary files drop into next-intl later unchanged.

## B.2 i18n foundations

Create:
- `apps/web/lib/i18n/dictionaries/en.ts` — typed source-of-truth, nested by screen (`nav`, `dashboard`, `opportunities`, `marketplace`, `learning`, `onboarding`, `common`).
- `ha.ts` / `yo.ts` / `ig.ts` — `DeepPartial<Dictionary>` (start empty); resolver falls back to `en`.
- `apps/web/lib/i18n/index.tsx` — `I18nProvider` (context, locale persisted to `localStorage` key `agric.locale`, same pattern as `lib/app-state.tsx`), `useT()` hook → `t('dashboard.title')`; updates `document.documentElement.lang` on switch.
- `apps/web/components/locale-switcher.tsx` — labelled `<select>` ("Language / Harshe / Èdè / Asụsụ") listing the four `LANGUAGE_CODES`; place in `nav.tsx` + footer. Empty dicts = working scaffold proving the plumbing.

Modify (string extraction, 3–5 highest-traffic surfaces only): `layout.tsx` (wrap children), `nav.tsx`, dashboard, opportunities (+`opportunity-browser.tsx`), learning, marketplace (+listing form buttons), onboarding wizard chrome. Everything else stays hardcoded with a tracking note.

Low-literacy UX rules (dictionary header comments): max ~8 words per UI string; verbs-first button labels; digits not words; no icon-only buttons (already true — keep it); sentence case; no idioms; CEFR A2 reading level.

## B.3 Accessibility hardening pass (verified findings)

| File | Fix |
|---|---|
| `app/globals.css` | Add `.sr-only`; `.btn-small` min-height 36→44px, `.chip` 38→44px, `.nav-links a` 40→44px; badge-info text `#8a6d4b`→`#6e5535`; badge-critical + `--ink-mute` → ~`#5f6b58`; blanket reduced-motion (`* { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }`) |
| `app/layout.tsx` | `<main id="main-content" tabIndex={-1}>` |
| `components/nav.tsx` | inline off-screen style → `.sr-only` |
| `components/opportunity-browser.tsx` | `<fieldset><legend>Filter opportunities</legend>`; explicit `aria-live="polite"`; per-card `aria-label={`Apply for ${opp.title}`}` |
| `components/forms.tsx` | wire `aria-describedby={hint ? `${id}-hint` : undefined}` onto the control (hint id exists but nothing references it — clone child or pass prop) |
| `components/ui.tsx` | MetricCard trend glyphs `aria-hidden` + `.sr-only` "up/down" |
| `components/queue-list.tsx` | status badges get clarifying `aria-label` (low priority) |

No modal/drawer components exist → no focus-trap work (stated to avoid scope invention).

## B.4 Automated checks (no browser available — all must run headless)

- eslint jsx-a11y gap rules after `--print-config` audit; fix newly flagged issues.
- `apps/web/vitest.config.ts` (`environment: 'jsdom'`, plugin-react, aliases `@/*` and `@agric-platform/shared` → `../../packages/shared/src/index.ts`) + `test/setup.ts` (`vi.mock('next/navigation')`) + `test/a11y.spec.tsx`:

```tsx
// sketch
expect.extend(toHaveNoViolations);
it('form primitives have no violations', async () => {
  const { container } = render(
    <form>
      <Field id="t1" label="Phone" hint="Used for OTP sign-in"><TextInput id="t1" inputMode="tel" /></Field>
      <CheckRow id="c1" checked onChange={() => {}} label="SMS alerts" />
      <ProgressBar value={40} label="Profile completion" />
      <StatusBadge tone="info">grant</StatusBadge>
      <EmptyState title="Nothing here" />
    </form>
  );
  expect(await axe(container)).toHaveNoViolations();
});
// + composite: <AppProvider><OpportunityBrowser/></AppProvider>, OnboardingWizard
```

- Add `"test": "vitest run"` to `apps/web/package.json` (root `npm test` picks it up).
- Contrast regression test: `apps/web/test/contrast.spec.ts` parses `:root` custom properties + badge rules from `globals.css` (regex + WCAG luminance, ~40 lines, zero deps), asserts pairs ≥ 4.5 — encodes the §0 measured failures as regression tests.

## B.5 PWA checks

- `sw.js`: (1) cache-eviction cap — trim page cache to newest ~50 entries after `cache.put`; (2) non-navigation fetch catch → `Response.error()`/504 JSON for `/api/*` instead of `undefined`; (3) update flow — remove unconditional `skipWaiting()`; `sw-register.tsx` listens for `waiting` and surfaces an "Update available — refresh" `role="status"` banner; on confirm `postMessage({type:'SKIP_WAITING'})` + `controllerchange` → reload (don't yank farmers mid-form).
- Manifest: add `icon-192.png`/`icon-512.png` entries (`any` + maskable); asset production marked external.
- Static vitest guard: `sw.js` text contains `/offline` in APP_SHELL and the navigate handler references it.
- Header rule for icons: `max-age=86400` (non-hashed names — not immutable).

## B.6 Ordered task list — Coder Agent B

1. Dev deps + vitest config + setup; trivial test green.
2. eslint jsx-a11y audit → enable gap rules → fix flagged.
3. CSS: `.sr-only`, touch targets, contrast, reduced-motion blanket.
4. Contrast regression test (failing-first in 3).
5. Component fixes: layout tabIndex, nav `.sr-only`, forms `aria-describedby`, opportunity fieldset/aria-labels, ui trend glyphs.
6. axe smoke tests (forms/ui + OpportunityBrowser + OnboardingWizard).
7. i18n scaffold + extraction for nav/dashboard/opportunities/learning/marketplace/onboarding chrome.
8. PWA: sw.js eviction/error/update flow + update banner + manifest icon entries.
9. `npm run validate` root.

**Risks:** `next/navigation` needs vitest stub; touch-target bumps change visual density (no browser — visual regression is external verification); keep locale persistence in its own key `agric.locale`; `app-state.tsx`/`nav.tsx`/`layout.tsx` are high-conflict files — sequence after the frontend-wiring wave lands.

---

# External verification (cannot be validated in this environment)

1. Screen-reader testing (TalkBack on Android priority; NVDA secondary).
2. Real Lighthouse run (a11y + PWA); PWA installability on physical Android.
3. Keyboard walkthrough on a real browser (skip-link focus, focus-visible, traps).
4. Service-worker update flow end-to-end (needs browser lifecycle).
5. Sentry delivery with a real DSN; verify `beforeSend` scrubbing against real events.
6. Prometheus scrape + alert rules + k8s `ServiceMonitor` wiring (infra).
7. Outdoor/sunglare contrast on real screens (computed AA passes; legibility is empirical).
8. Hausa/Yoruba/Igbo translation quality — scaffold only; needs native-speaker review.

# Cross-wave coordination flags

- Shared-package additive edits (`ApiErrorResponse`, `AuditEvent` hash fields) — lead coordinates.
- `bootstrap.ts`/`app.module.ts` — single owner per wave; A sequences after persistence.
- `layout.tsx`/`nav.tsx`/`app-state.tsx` — B sequences after frontend wiring.
