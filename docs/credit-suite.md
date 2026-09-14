# Credit suite (Wave CREDIT)

Best-of-both merge of the `farmer-data-collection` microfinance suite into
AgricPlatform. New `credit` schema (migration `infra/postgres/025_credit.sql`),
new `apps/api/src/modules/credit` module, web pages `/credit` and
`/admin/credit`.

## Scope

- **Loan products** — admin-managed catalogue (`/credit/products`), public list.
- **Loan lifecycle** — guarded state machine:
  `draft → submitted → scoring → approved|rejected → disbursed → repaying → repaid|defaulted → written_off`.
  Every transition is a compare-and-set (`updateExpected`) with an audit entry
  and a domain event (transactional outbox on PostgreSQL).
- **Scoring** — deterministic 5-factor model (0–1000), ported from the source
  suite's `credit-scoring.ts` semantics and re-anchored to platform data:
  repayment history (own loan repo), farm profile completeness
  (`profiles.completionScore`), transaction volume (marketplace orders),
  guarantor strength (accepted guarantors), group standing (VSLA membership /
  leadership / group savings). No ML dependency; same data → same score.
- **Repayments** — equal-installment schedule generated at approval; annual
  interest bps prorated over the term with bigint math (exact kobo, no
  floats). Late marking is read-time (`due_at < now && pending → late`), no
  timers.
- **PAR reporting** — `GET /credit/portfolio` (admin|lender): PAR30/60/90 as
  integer basis points, outstanding totals, defaults.
- **Chama/VSLA** — groups with leader/member roles, group loan applications
  that record every other member as an accepted co-obligor guarantor row, and
  group savings accounts (leader moves money, members read).
- **Savings** — personal + group accounts; every deposit/withdrawal is
  idempotent by caller `ref` and atomic (balance CAS + transaction append +
  outbox event in one unit of work).

## Funds integration note (v1)

Disbursement is a **recorded event** (`credit.loan.disbursed`): no money moves
inside the credit module. Actual money movement stays with the hardened
funds/escrow flow (`modules/finance` ledger + `modules/marketplace` escrow) —
this wave makes **no changes** to those modules. A later wave can subscribe a
disbursement adapter to `credit.loan.status_changed` (to=`disbursed`) that
posts the corresponding double-entry ledger transfer through the existing
`LedgerService` public API.

## Stage 27 additions (2026-09-14)

The credit surface was extended by the Stage 27 wave (evidence-pack §1; merge-log):

- **SeasonSync seasonal repayment schedules** (inn-01, PR #69): seasonal repayment calendars in this module, migration `055_credit_seasonal_schedules.sql`, pg contract spec `apps/api/test/pg/seasonal-schedule.pg.spec.ts`, flag `seasonal-repayment` (default OFF).
- **Credit Passport** (inn-07, PR #76): separate `credit-passport` module — verifiable, revocable credit credentials with disclosure sharing; migration `065_credit_passport.sql`; `CREDIT_PASSPORT_SECRET` is a constructor-time requirement when enabled.
- **Cooperative Score** (inn-14, PR #86) and **Lender Lens scorecards** (inn-20, PR #91 via #98): analytics-side scoring/export surfaces (migrations 072/079), default-OFF flags.
- **VSLA money-path atomicity** (WP-G1, PR #72): savings/repayment postings folded into caller-owned transactions (migration 060); the funds-integration note above still stands — disbursement itself remains a recorded event, and ledger invariants were hardened (WP-G13, PR #84).
