# PostgreSQL Persistence Wave — Implementation Plan

> Status: **LANDED (code-complete)** on branch `production-persistence` (2026-02-19).
> Wave A (async port, in-memory rewrite, config, stores, services/controllers/core
> async, gate green), Wave B (001_init.sql drift rewrite, migrate/lint:sql, pg base +
> mappers + 27 pg repositories, contract suites, SQL snapshots, seed.ts), and Wave C
> (transactions, certificate counter, Redis wiring, .env.example, readiness docs) are
> implemented. `npm run validate` green: 134 tests passed, 51 pg/Redis-gated tests
> skipped without DATABASE_URL/REDIS_URL. **External blocker:** running the gated
> pg/Redis suites against real containers (docker unavailable in the build
> environment) plus staging soak.
>
> Original handoff note: approved plan, ready for coder handoff. Produced by read-only
> exploration of main after the security merge.

## 0. Verified context

- **Repository port**: `apps/api/src/common/in-memory.repository.ts` — sync `Repository<T>` with predicate functions (`find((item) => …)`), used directly by **12 services**: users, profiles, privacy, learning, community, opportunities, chapters, marketplace, advisory, finance, notifications (+ admin/search/dashboard/analytics/partner consume those services).
- **Ad-hoc in-memory state outside repos**: `AuthService.challenges` (OTP Map), `AdminService.accountStatuses` (Map), `NotificationsService.deliveryLog` (array), `AuditService.events` (array), `DomainEventsService.outbox` (array), `IdempotencyInterceptor.store` (Map).
- **Controllers**: all 17 controllers wrap service returns synchronously (`return { data: this.service.x() }`) — every handler must become `async`/`await`.
- **Seeds**: split across `packages/shared/src/data.ts` (courses, opportunities, chapters, advisory, listings, platformMetrics) and `apps/api/src/database/seed-data.ts` (users, profiles, consents, enrolments, certificates, forum topics, mentor requests, chapter events, RSVPs, announcements, applications, orders, credit profiles, vault documents, notification prefs/messages + local-only interfaces `ChapterAnnouncement`, `EventRsvp`, `OrderReview`, `TopicFlag`, `DeletionRequest`).
- **docker-compose is at `infra/docker-compose.yml`**: postgres:16-alpine mounts `./postgres` into `docker-entrypoint-initdb.d` (001 runs on first boot only); redis:7-alpine with AOF; api service already receives `DATABASE_URL`/`REDIS_URL`.
- **Testing**: vitest everywhere; e2e in `apps/api/test/` boots `AppModule` in-process.
- **Auth wave integration point (already landed on main)**: OIDC/JWT verification in `RolesGuard`, OTP hardening (attempt counter/lockout/expiry), throttler, webhook HMAC. This wave only swaps the OTP Map for `OTP_STORE` and asyncifies auth service internals — do NOT touch token issuance, guards, or decorators.

## 1. Key architecture decisions

| # | Decision | Choice | Justification |
|---|----------|--------|---------------|
| D1 | DB access | **`pg` (node-postgres) + hand-rolled SQL with a thin `PgRepositoryBase`** | No ORM in the dependency tree; the team owns a hand-written multi-schema SQL file (15 schemas) that Prisma/TypeORM would fight. `pg` is ESM-clean, tiny, and lets repositories hand-tune array-containment/partial-index queries. Add `@types/pg`. |
| D2 | Redis client | **`ioredis`** | De-facto standard in the NestJS ecosystem, robust TS types, atomic `SET key val PX ttl NX` semantics needed for idempotency; compatible with a future throttler Redis store. |
| D3 | Entity IDs | **DB PKs `text`; keep app-generated `newId(prefix)` ids** | All seed/API ids are prefixed strings (`user-adamu`, `course-cassava-foundations`). Text PKs preserve the public contract; type safety is enforced by the API layer. |
| D4 | Migration approach | **Rewrite `001_init.sql` in place** (pre-production; container init only ever ran it on empty volumes) **+ numbered migrations from `002_*` onward** with a tiny runner + `schema_migrations` table. |
| D5 | Repository port | **Async generic base + per-domain ports with typed criteria objects**. Predicates never cross the port boundary; in-memory impls receive a `matcher: (criteria) => (item) => boolean` so unit tests keep full fidelity without SQL. |
| D6 | Fail-closed boot | `NODE_ENV=production` + no `DATABASE_URL` → throw during `AppModule` init unless `ALLOW_INMEMORY_PERSISTENCE=true`. Same for Redis (`ALLOW_INMEMORY_CACHE`). |

## 2. Async repository contract design

### 2.1 New base port — `apps/api/src/common/async-repository.ts` (new)

```ts
export interface AsyncRepository<T extends { id: string }, TCriteria = void> {
  all(): Promise<T[]>;
  find(criteria: TCriteria): Promise<T[]>;
  findOne(criteria: TCriteria): Promise<T | undefined>;
  findById(id: string): Promise<T | undefined>;
  getById(id: string): Promise<T>;            // throws NotFoundException
  create(item: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T>;
  remove(id: string): Promise<boolean>;
  count(criteria?: TCriteria): Promise<number>;
}
```

Move `newId()` here (update all import sites; single owner).

### 2.2 In-memory base — rewrite `apps/api/src/common/in-memory.repository.ts`

```ts
export class InMemoryRepository<T extends { id: string }, TCriteria = void>
  implements AsyncRepository<T, TCriteria> {
  constructor(seed: readonly T[] = [],
              private readonly matcher?: (criteria: TCriteria) => (item: T) => boolean) { … }
  // every method = current logic, async signature; find/count route criteria through matcher
}
```

### 2.3 pg base — `apps/api/src/database/pg/pg-repository.base.ts` (new)

- Wraps `pg.Pool`; constructor takes `{ table: string; mapper: RowMapper<T>; criteria?: CriteriaSqlBuilder<TCriteria> }`.
- `CriteriaSqlBuilder` returns `{ where: string; params: unknown[] }` with positional `$n` placeholders composed from whitelisted fragments only (never string-concat user input).
- Helpers: `insert()`, `updateById()`, `select(where, order, limit/offset)`.
- `withTransaction(fn)` for read-modify-write flows; transactions stay inside repositories (never leak `PoolClient` into services).
- `mapPgError(err)`: `23505` → `ConflictException`, `23503` → `BadRequestException`.

### 2.4 Per-domain ports, criteria, and SQL mapping

| Domain port (under `apps/api/src/database/repositories/`) | Entity / criteria | SQL table (post-alignment) | Notes / bespoke methods |
|---|---|---|---|
| `user.repository.ts` | `User`; `UserCriteria { role?, q? }` | `identity.users` + `identity.user_roles` | `q` → ILIKE full_name/phone; role → EXISTS user_roles; **bespoke** `searchPage`, `countByRole`, `setStatus`, `anonymize`; roles hydrated via array_agg join. |
| `profile.repository.ts` | `Profile`; `{ userId?, state? }` | `profiles.member_profiles` | keyed by user_id; **bespoke** `countByState()` (GROUP BY). |
| `consent.repository.ts` | `ConsentRecord`; `{ userId? }` | `privacy.consent_records` | trivial. |
| `deletion-request.repository.ts` | `DeletionRequest`; `{}` | `privacy.data_requests` (aligned) | map `request_type='deletion'`. |
| `course.repository.ts` | `Course`; `{ category?, level?, language?, q? }` | `learning.courses` (aligned) | ILIKE title; **bespoke** `searchPage`. |
| `enrolment.repository.ts` | `Enrolment`; `{ userId?, courseId?, status? }` | `learning.enrolments` | `countCompleted()`; unique (user_id, course_id) backs ConflictException. |
| `certificate.repository.ts` | `Certificate`; `{ userId?, verificationCode? }` | `learning.certificates` (aligned) | `NYFN-CERT-YYYY-####` from DB counter table `learning.certificate_counters(year PK, next int)` with `UPDATE … RETURNING`. |
| `forum-topic.repository.ts` | `ForumTopic`; `{ category?, state?, crop?, q? }` | `community.forum_topics` (**new**) | `incrementReplyCount()` atomic; **bespoke** `searchPage`. |
| `mentor-request.repository.ts` | `MentorRequest`; `{ userId?, status? }` | `community.mentor_requests` (**new**) | trivial. |
| `topic-flag.repository.ts` | `TopicFlag`; `{ status? }` | `community.topic_flags` (**new**) | trivial. |
| `opportunity.repository.ts` | `Opportunity`; `{ state?, valueChain?, type?, active? }` | `opportunities.opportunities` (aligned) | array containment `@>`; **bespoke** `findRecommendedForProfile(state, chains)` with empty-array = match-all semantics; `findByPartner`. |
| `application.repository.ts` | `OpportunityApplication`; `{ userId?, opportunityId?, status? }` | `opportunities.applications` | **bespoke** `findForPartner(partnerId)` (JOIN); `findActive(opportunityId, userId)`; partial unique index backstop. |
| `chapter.repository.ts` | `Chapter`; `{ level?, state?, parentId? }` | `chapters.chapters` (aligned) | trivial + `searchPage`. |
| `chapter-event.repository.ts` | `ChapterEvent`; `{ chapterId? }` | `chapters.events` (aligned) | atomic `incrementRsvp/incrementAttendance`. |
| `event-rsvp.repository.ts` | `EventRsvp`; `{ eventId?, userId?, status? }` | `chapters.event_participation` (**new**) | upsert `ON CONFLICT (event_id,user_id) DO UPDATE`. |
| `announcement.repository.ts` | `ChapterAnnouncement`; `{ chapterId? }` | `chapters.announcements` | trivial. |
| `advisory.repository.ts` | `AdvisoryItem`; `{ kind?, state?, crop? }` | `advisory.items` (**new unified**) | trivial + `searchPage`. |
| `listing.repository.ts` | `MarketplaceListing`; `{ kind?, state?, crop?, active?, q? }` | `marketplace.listings` (aligned) | `activeListingCount`; **bespoke** `searchPage`. |
| `order.repository.ts` | `Order`; `{ buyerId?, sellerId?, status? }` | `marketplace.orders` (aligned) | idempotency_key column for natural dedupe. |
| `review.repository.ts` | `OrderReview`; `{ orderId? }` | `marketplace.reviews` | trivial. |
| `credit-profile.repository.ts` | `CreditProfile`; keyed by userId | `finance.credit_profiles` (aligned) | upsert. |
| `document.repository.ts` | `VaultDocument`; `{ userId?, status? }` | `finance.documents` (aligned) | trivial. |
| `notification.repository.ts` | `NotificationMessage`; `{ userId?, status? }` | `notifications.notifications` (aligned) | `countUnread(userId)`; idempotency_key column. |
| `notification-preference.repository.ts` | `NotificationPreference`; composite key | `notifications.user_preferences` (aligned: PK (user_id, channel)) | upsert. |
| `delivery-log.repository.ts` | `DeliveryLogEntry`; `{ notificationId? }` | `notifications.delivery_logs` | trivial. |
| `audit.repository.ts` | `AuditEvent`; `{ actorId?, entityType? }` | `admin.audit_events` | append-only. |
| `outbox.repository.ts` | `DomainEvent` | `events.outbox` (aligned) | append-only; `listOutbox`. |

### 2.5 Services with complex predicate logic needing bespoke SQL

1. **OpportunitiesService.recommendedFor** — profile-match with empty-array semantics. Highest-risk query.
2. **OpportunitiesService.applicationsForPartner** — join.
3. **Users/Learning/Community/Marketplace/Chapters/Advisory list** — identical "filter + ILIKE q + paginate" pattern → `searchPage` per pg repo. **Pagination pushes into SQL** (`LIMIT/OFFSET` + count); keep `common/pagination.ts` for envelope shape + in-memory repos; add `pageSlice(total, data, page, pageSize)` helper.
4. **AnalyticsService.segments('state')** — GROUP BY on profiles.
5. **FinanceService.creditProfile** — cross-repo compute; `Promise.all`.
6. **PrivacyService.exportUser** — fan-out reads; `Promise.all` (read-only).
7. **SearchService.search** — fans out across 6 services; `Promise.all`; full-table scans acceptable Phase 1 (Meilisearch adapter is the documented production path).
8. **ChaptersService.recordAttendance / LearningService.updateProgress / MarketplaceService.placeOrder** — read-modify-write inside repository transactions.
9. **DashboardService.dashboardFor** — lookups → `Promise.all`.
10. **PartnerService.impactReport / participants** — sequential awaits; note N+1 as follow-up.

## 3. File-by-file change list

### 3.1 New files — infrastructure

| File | Content |
|---|---|
| `apps/api/src/config/persistence.config.ts` | Env parsing: `DATABASE_URL`, `REDIS_URL`, `ALLOW_INMEMORY_PERSISTENCE`, `ALLOW_INMEMORY_CACHE`, `NODE_ENV`. `resolvePersistenceMode()` → `'pg'|'memory'` with fail-closed throw in production. |
| `apps/api/src/common/async-repository.ts` | Port + `newId()` (moved). |
| `apps/api/src/database/database.module.ts` | `@Global()`; provides `PG_POOL` + all repository tokens. |
| `apps/api/src/database/pg/pg-pool.provider.ts` | Pool factory + `onModuleDestroy` pool.end(). |
| `apps/api/src/database/pg/pg-repository.base.ts` | §2.3. |
| `apps/api/src/database/pg/row-mappers.ts` | snake_case↔camelCase per entity; explicit, no auto-casing magic; jsonb columns round-trip whole. |
| `apps/api/src/database/repositories/*.repository.ts` | 25 files per §2.4. |
| `apps/api/src/database/migrate.ts` | Migration runner CLI: applies `infra/postgres/*.sql` in lexical order into `schema_migrations(filename PK, applied_at)`; idempotent; baseline-detection via `to_regclass('identity.users')` for docker-entrypoint-initialized DBs. |
| `apps/api/src/database/seed.ts` | Seed CLI (§6). |
| `apps/api/src/redis/redis.module.ts` | `@Global()`; provides `REDIS_CLIENT` (ioredis) or null; fail-closed mirrored. |
| `apps/api/src/redis/key-value-store.ts` | `KeyValueStore` interface + `InMemoryKeyValueStore` (TTL sweep) + `RedisKeyValueStore` (`SET … PX … NX`). |
| `apps/api/src/redis/idempotency.store.ts` | `IdempotencyStore` over KeyValueStore (JSON-serialized). |
| `apps/api/src/redis/otp-challenge.store.ts` | `OtpChallengeStore { save; get; consume }` — `consume` = GETDEL (atomic single-use). |
| `apps/api/src/database/persistence.tokens.ts` | DI tokens for all repositories + stores + pools. |
| `apps/api/test/contract/repository.contract.ts` | Shared vitest contract suite factory. |
| `apps/api/test/contract/*.contract.spec.ts` | Per-aggregate suites (users, courses, orders, enrolments, notifications first). |
| `apps/api/test/pg/*.pg.spec.ts` | pg impls, `describe.skipIf(!process.env.DATABASE_URL)`. |
| `apps/api/test/unit/*.spec.ts` | OTP store, idempotency store, criteria builders, mappers, config fail-closed. |
| `scripts/lint-migrations.mjs` | SQL lint via `pgsql-ast-parser`; npm script `lint:sql` wired into root validate. |

### 3.2 Modified files — common/core/infra

| File | Change |
|---|---|
| `apps/api/src/common/in-memory.repository.ts` | Rewrite as async generic (§2.2); update all import sites for `newId`. |
| `apps/api/src/common/pagination.ts` | Add `pageSlice` helper. |
| `apps/api/src/common/interceptors/idempotency.interceptor.ts` | Inject `IDEMPOTENCY_STORE`; `intercept` async; register via `APP_INTERCEPTOR` provider (bootstrap currently news it up — move to DI). |
| `apps/api/src/bootstrap.ts` | Replace manual interceptor instantiation with provider-registered one; keep raw-body/HMAC wiring from the security wave intact. |
| `apps/api/src/core/audit.service.ts` | Inject `AUDIT_REPOSITORY`; `record()`/`list()` async. |
| `apps/api/src/core/domain-events.service.ts` | Inject `OUTBOX_REPOSITORY`; `publish()` async — ripples to ~30 call sites (mechanical `await`); EventEmitter fan-out stays sync after await. |
| `apps/api/src/core/core.module.ts` | Register repository-backed providers; stays `@Global()`. |
| `apps/api/src/core/domain-events.service.spec.ts` | Update to async publish. |
| `apps/api/src/health/health.controller.ts` | `/health/ready` adds `persistence: { database: 'up'|'down'|'disabled', redis: … }`; `SELECT 1` (1s timeout) + `PING`; `down` ⇒ `status:'degraded'`. |
| `apps/api/src/app.module.ts` | Import `DatabaseModule`, `RedisModule`. |

### 3.3 Modified files — services

Every method → async; predicates → criteria. Per-service notes: users (searchPage, ConflictException via 23505 on phone UNIQUE, anonymize), profiles (drop `Profile & {id}` wrapper, upsert), auth (OTP Map → OTP_STORE; `verifyOtp` atomic `consume`; do NOT touch token issuance/guards), learning (3 repos, enrol 409 via 23505, updateProgress transactional, certificate counter), community (3 repos, atomic reply count), opportunities (2 repos, recommendedFor bespoke, applicationsForPartner join, partial unique index), chapters (4 repos, rsvp conflict via PK, recordAttendance upsert, atomic counters), marketplace (3 repos, placeOrder transactional, keep ORDER_TRANSITIONS state machine from security wave), advisory (1 repo), finance (2 repos, async fan-out + upsert), notifications (3 repos, drop composite-key hack, send = 3 writes in one transaction), admin (`accountStatuses` Map → `identity.users.status` via repo `setStatus`), analytics (`countByState`), dashboard/partner/search (Promise.all fan-outs), privacy (consents + deletion repos, exportUser bundle).

### 3.4 Modified files — controllers (all 17)

Every handler: `async` + `await`. Special case: `learning.controller.ts` certificate verification sync callback becomes async resolver; `LearningService.verifyCertificate` accepts an async resolver.

### 3.5 Module wiring

All 18 `*.module.ts`: repositories come from `@Global() DatabaseModule` → most modules need no import changes. `app.module.ts` gains Database/Redis modules.

### 3.6 Tests

- Existing e2e must pass unmodified in in-memory mode (primary regression gate); add readiness assertion for `database: 'disabled'`.
- New contract/unit/pg suites per §3.1.

## 4. Schema alignment — drift register (001_init.sql vs TS contracts)

Decision D3: all entity PK/FK columns `uuid` → `text` on API-owned tables.

1. **identity.users** — PK → `text`; add `kyc_tier text NOT NULL DEFAULT 'tier_0' CHECK (…)`; add `is_verified boolean NOT NULL DEFAULT false`; add `last_active_at timestamptz`; roles stay in `user_roles` join (hydrate via array_agg).
2. **profiles.member_profiles** — PK → `text`; add `value_chains text[]`, `bio text`, `badges text[]`; rename `primary_crops` → `farming_interests`; add `latitude numeric(9,6)`, `longitude numeric(9,6)`.
3. **privacy.data_requests** — status CHECK → `('pending','completed')`; `fulfilled_at` → `completed_at`.
4. **learning.courses** — add `category`, `level`, `duration_minutes int`, `enrolment_count int`, `offline_available bool`; `slug` nullable; PK → `text`.
5. **learning.enrolments** — SQL status superset incl. `'dropped'` is safe; PK → `text`.
6. **learning.certificates** — add `user_id text NOT NULL`, `course_id text NOT NULL REFERENCES learning.courses(id)`, `verification_url text`; drop `enrolment_id`; add `learning.certificate_counters(year int PK, next int)`.
7. **community.forum_topics** — NEW TABLE (DDL §4 snippets).
8. **community.mentor_requests** — NEW TABLE (`requested|matched|closed`); keep `mentorship_pairs` for future.
9. **community.topic_flags** — NEW TABLE (`open|resolved`).
10. **opportunities.opportunities** — CHECK with 8 TS type values; add `value_chains text[]`; `eligibility jsonb` → `text[]`; `partner_ref uuid` → `partner_id text`; replace status with `is_active boolean NOT NULL DEFAULT true`; `deadline date` → `timestamptz`; PK → `text`.
11. **opportunities.applications** — status CHECK → TS values (`submitted,under_review,successful,unsuccessful,withdrawn`); add `notes text`; partial unique index `(opportunity_id,user_id) WHERE status <> 'withdrawn'`.
12. **chapters.chapters** — add `lead_user_id text`, `member_count int NOT NULL DEFAULT 0`, `active boolean NOT NULL DEFAULT true`; PK → `text`.
13. **chapters.events** — add `type text CHECK ('meeting','training','field_visit','programme')`, rename `venue`→`location`, add `rsvp_count`, `attendance_count`.
14. **chapters.event_participation** — NEW TABLE aligned to EventRsvp (single row, status `rsvp|attended`, UNIQUE(event_id,user_id)); leave old `event_rsvps`/`event_attendance` for future or drop.
15. **chapters.announcements** — mapper handles `authorId/publishedAt` ↔ `published_by/published_at`; PK → `text`.
16. **advisory.items** — NEW unified table; keep specialized snapshot tables for ingest pipelines.
17. **marketplace.listings** — extend kind CHECK to 6 TS values; rename `type`→`kind`, `commodity`→`crop`; add `location_ward`, `location_latitude/longitude` (or `location jsonb`; keep `location_state` column for the partial search index); `is_active boolean`; add `harvest_date date`; PK → `text`.
18. **marketplace.orders** — status CHECK → 9 TS values; add `seller_id text NOT NULL`, `escrow_required boolean NOT NULL DEFAULT false`; `total_ngn`→`total_naira numeric(14,2)`; `placed_at`→`created_at`; keep `idempotency_key text UNIQUE`; PK → `text`.
19. **marketplace.reviews** — rename `reviewer_id` → `author_id`; PK → `text`.
20. **finance.credit_profiles** — add `score smallint`, `training_signals smallint`, `transaction_signals smallint`, `production_signals smallint`, `document_count smallint`, `improvement_actions text[]`; mark local `kyc_tier` deprecated (canonical on users); user_id → `text`.
21. **finance.documents** — rename `doc_type`→`kind` + CHECK with 6 TS values; `storage_ref` nullable + add `file_name text NOT NULL`; status CHECK incl. `'expired'` superset OK.
22. **notifications.user_preferences** — drop `topic`; PK `(user_id, channel)`.
23. **notifications.notifications** — status CHECK `('queued','sent','delivered','failed','read','suppressed')`; add `title text NOT NULL`, `body text NOT NULL`; `queued_at`→`created_at`; PK → `text`.
24. **notifications.delivery_logs** — mapper maps `result` jsonb into `detail`; PK → `text`.
25. **admin.audit_events** — `actor_id text`; rename targets → `entity_type/entity_id`; `detail`→`metadata`; `occurred_at`→`created_at`.
26. **events.outbox** — `aggregate_id text NULL`; add `actor_id text NULL`; rename `event_type`→`name`; PK → `text`.
27. **Seed INSERTs in 001** — drop demo `chapters` insert (seed script owns demo data); keep role rows + integration providers as reference data.

### Corrected DDL snippets (worst mismatches)

```sql
CREATE TABLE identity.users (
    id              text PRIMARY KEY,
    external_subject text UNIQUE,
    phone           text UNIQUE,
    email           text UNIQUE,
    full_name       text NOT NULL,
    preferred_language text NOT NULL DEFAULT 'en'
                    CHECK (preferred_language IN ('en','ha','yo','ig')),
    kyc_tier        text NOT NULL DEFAULT 'tier_0'
                    CHECK (kyc_tier IN ('tier_0','tier_1','tier_2','tier_3')),
    is_verified     boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deactivated','pending_deletion')),
    last_active_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community.forum_topics (
    id          text PRIMARY KEY,
    title       text NOT NULL,
    category    text NOT NULL,
    author_id   text NOT NULL,
    state       text,
    crop        text,
    reply_count integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forum_topics_filter_idx ON community.forum_topics (category, state, crop);

CREATE TABLE chapters.event_participation (
    id          text PRIMARY KEY,
    event_id    text NOT NULL REFERENCES chapters.events(id) ON DELETE CASCADE,
    user_id     text NOT NULL,
    status      text NOT NULL CHECK (status IN ('rsvp','attended')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, user_id)
);

-- marketplace.orders (aligned excerpt)
    status      text NOT NULL DEFAULT 'requested' CHECK (status IN
                ('requested','negotiating','confirmed','deposit_paid','in_fulfilment',
                 'delivered','completed','disputed','cancelled')),
    seller_id   text NOT NULL,
    escrow_required boolean NOT NULL DEFAULT false,
    total_naira numeric(14,2) NOT NULL,
    idempotency_key text UNIQUE,

CREATE UNIQUE INDEX applications_active_unique
    ON opportunities.applications (opportunity_id, user_id) WHERE status <> 'withdrawn';

CREATE TABLE advisory.items (
    id          text PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('crop_calendar','pest_alert','weather','price','guide')),
    title       text NOT NULL,
    summary     text NOT NULL,
    state       text,
    crop        text,
    severity    text CHECK (severity IN ('info','warning','critical')),
    published_at timestamptz NOT NULL DEFAULT now()
);
```

## 5. DB access layer detail

- `apps/api/package.json` deps: `pg@^8`, `ioredis@^5`; devDeps `@types/pg@^8`, `tsx@^4`, `pgsql-ast-parser@^13`. No `@nestjs/config` (hand-rolled config keeps parity with current env style).
- npm scripts: `"migrate": "tsx src/database/migrate.ts"`, `"seed": "tsx src/database/seed.ts"`, root `"lint:sql"`.
- Transactions inside repositories only; the three multi-write flows (placeOrder, rsvp+counter, updateProgress+certificate) transact internally.

## 6. Seeding design

`seed.ts` CLI: requires `DATABASE_URL`; aborts with "run migrate first" if `to_regclass('identity.users')` is null; builds pg repositories and inserts in FK-safe order (users → user_roles → profiles → consents → courses → enrolments → certificates → forum_topics → mentor_requests → chapters → events → participation → announcements → opportunities → applications → listings → orders → credit_profiles → documents → notification prefs → messages → advisory items); reuses exactly `packages/shared/src/data.ts` + `apps/api/src/database/seed-data.ts` arrays (no duplication); all writes `ON CONFLICT DO NOTHING`; expected row counts mirror e2e seeds (8 users, 8 profiles, 5 courses, 2 topics, 4 chapters, 3 opportunities, 3 listings, …).

## 7. Redis integration design

- `KeyValueStore` interface + in-memory (TTL sweep, preserves current 24h idempotency semantics) + Redis impls.
- Idempotency: scoped key format unchanged (`METHOD:path:key`); JSON body; 24h TTL; cross-instance replay safety via Redis; in-memory fallback preserves the e2e replay test.
- OTP: keyed by challenge id; JSON `{phone, codeHash, expiresAt, attempts}`; 5-min TTL; `consume` atomic GETDEL. AuthService public shapes unchanged (attempt-counter/lockout logic from the security wave stays in the service).
- Selection: `REDIS_URL` → Redis; else in-memory + startup warning; production + memory → boot failure unless `ALLOW_INMEMORY_CACHE=true`.

## 8. Config, fail-closed boot, health

- `resolvePersistenceMode()`: `DATABASE_URL` → `'pg'`; else production && !ALLOW_INMEMORY_PERSISTENCE → throw; else `'memory'`. Called in provider factories (throw during Nest init = fail-closed).
- `.env.example`: add `DATABASE_URL`, `REDIS_URL`, `ALLOW_INMEMORY_PERSISTENCE`, `ALLOW_INMEMORY_CACHE` (documentation only, no real credentials).
- Health: `/health/ready` gains `persistence` block; `disabled` in memory mode; `down` ⇒ degraded.

## 9. Test strategy (no Postgres available in this environment)

1. **Repository contract suites** — factory asserting the full AsyncRepository surface per aggregate (CRUD, criteria semantics, NotFound, conflict, upsert, counters, pagination totals); always runs against InMemory impls.
2. **pg suites** — same contracts parameterized to pg impls, `describe.skipIf(!process.env.DATABASE_URL)`; run elsewhere via `docker compose -f infra/docker-compose.yml up -d postgres`.
3. **Migration lint** — `scripts/lint-migrations.mjs` parses every `infra/postgres/*.sql` with `pgsql-ast-parser`; asserts clean parse, no unguarded DROP/TRUNCATE, PKs present; wired into root `validate`.
4. **Unit tests** — config fail-closed matrix, both store impls, criteria SQL builder snapshots (6 searchPage repos + recommendedFor), row-mapper round-trips.
5. **e2e** — existing suite must pass unchanged (in-memory default); add readiness-shape assertion.

## 10. Ordered task list (single coder)

**Wave A — foundations (no behavior change)**
1. Deps + npm scripts.
2. `async-repository.ts` + async `InMemoryRepository` rewrite (compile breaks expected; proceed service by service).
3. persistence config, database/redis modules, tokens, KV/idempotency/OTP stores + unit tests.
4. Core: audit, domain-events (+spec), idempotency interceptor DI, bootstrap, health.
5. Leaf services: advisory, community, learning, chapters, marketplace (+ their repositories).
6. users, profiles, opportunities, finance, notifications (+ repositories).
7. Composers: privacy, admin, analytics, dashboard, partner, search.
8. All 17 controllers → async.
9. **GATE: e2e green in pure in-memory mode before Wave B.**

**Wave B — schema + pg adapters**
10. Rewrite `infra/postgres/001_init.sql` (all 27 drift items); `lint:sql` in validate; `schema_migrations` + `migrate.ts`.
11. `pg-repository.base.ts`, `row-mappers.ts`, `mapPgError`.
12. pg repositories (same order as 5–6) + contract suite instances (in-memory always-on; pg skipped-unless-DATABASE_URL).
13. SQL builder snapshot tests.
14. `seed.ts` CLI + row-count verification.

**Wave C — hardening**
15. Transactions for placeOrder / rsvp / updateProgress; certificate counter table.
16. Redis wiring for interceptor + OTP behind config; e2e idempotency re-run both cache modes.
17. `.env.example` + docs touch-up.
18. Final `npm run validate` + docker-compose smoke instructions for ops.

Strict dependencies: 2→(4–8); 9 gates 10+; 10→12; 11→12.

## 11. Risk register

| Risk | Likelihood | Detection | Mitigation |
|---|---|---|---|
| Missed sync call site → Promise leaks into `{data}` envelope | High (100+ sites) | tsc + e2e body assertions | Convert controllers with services; typecheck per wave |
| Async `publish` breaks ordering / un-awaited rejects | Medium | unhandledRejection in vitest | Await all publishes; e2e guard |
| Criteria matcher vs SQL builder semantic divergence | Medium | Contract suites on both impls | Contract tests are the spec; snapshot trickiest SQL |
| Pagination total mismatch | Low-Medium | e2e pagination spec | Shared `pageSlice` helper |
| OTP/idempotency behavior change breaks existing e2e | Medium | e2e | In-memory fallbacks preserve exact semantics incl. TTLs |
| 001 rewrite breaks docker first-boot on old volumes | Medium | boot smoke | Runbook: `docker compose down -v` required |
| uuid→text churn misses a table | Medium | seed dry-run | §4 register is exhaustive; tick each item |
| Merge conflicts with landed security wave files | Medium | conflicts on `auth/*`, `bootstrap.ts`, interceptor | Keep auth edits minimal (OTP store only) |
| `notifications.send` partial failure | Low | pg fault-injection later | Single transaction (Wave C) |
| Certificate code sequence races | Low (pre-scale) | concurrent test | DB counter table `UPDATE … RETURNING` |

## 12. Assumptions

1. No production data exists → rewriting 001 in place is safe.
2. Text-PK decision compatible with OIDC `sub` mapping (`external_subject` column carries the Keycloak subject; `identity.users.id` stays app-generated text).
3. `tsx` acceptable as dev-time script runner.
4. `NODE_ENV=test` stays in-memory default; a second CI job with docker services runs pg suites (hand to ops).
