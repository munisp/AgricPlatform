# Nigerian Legal / Regulatory Review Checklist

> **Template prepared for qualified Nigerian legal review — not legal advice, not reviewed, not signed off.**
> Every checkbox requires a HUMAN sign-off by a qualified Nigerian lawyer, DPO or compliance
> officer. No item below is certified, reviewed or approved by the engineering team; the "code
> evidence" column only shows where the relevant tooling lives.

| # | PRD feature / area | Nigerian regulatory touchpoint | Code evidence pointer | Human sign-off |
|---|---|---|---|---|
| 1 | Marketplace escrow, order payments, refunds | **CBN/PSB licensing caution** — holding buyer funds in escrow may constitute payment-service business requiring a CBN licence (PSB/PSSP). Refund handling also engages FCCPA consumer-protection duties. Assumption "provider holds the funds, platform never does" MUST be confirmed. | `apps/api/src/database/repositories/escrow.repository.ts`, `marketplace.pg-repository.ts` (guarded state transitions); payment webhooks in `integrations` module | ☐ Counsel: __________ Date: ____ |
| 2 | Personal-data processing at scale | **NDPA 2023** — registration with the NDPC as a data controller (likely "of major importance"); appoint DPO; filing of compliance audit returns | This directory (`ndpa-data-inventory.md`, `dpia-template.md`); `compliance` module | ☐ DPO: __________ Date: ____ |
| 3 | Consent management | NDPA s.25–26 (lawful basis, granular/withdrawable consent) | `POST /compliance/consents`, `DELETE /compliance/consents/:purpose`, `GET /compliance/consents/mine`; migration `021_compliance.sql` | ☐ DPO: __________ Date: ____ |
| 4 | Data-subject rights | NDPA s.37 (access/portability), s.38 (erasure) | `POST /compliance/dsr/export`, `POST /compliance/dsr/erasure`, `POST /compliance/dsr/:id/approve|reject`; erasure = anonymisation with legal hold on financial/audit rows | ☐ Counsel: __________ Date: ____ |
| 5 | Records retention | NDPA storage-limitation principle; financial record statutes (CBN/BOFIA — counsel to confirm periods) | `compliance.retention_policies` + `POST /compliance/retention/sweep`; `docs/compliance/retention-policy.md` | ☐ DPO: __________ Date: ____ |
| 6 | Accountability / audit evidence | NDPA accountability + security-safeguard duties; regulator inspections | Hash-chained audit log: `GET /admin/audit-log/verify`; evidence pack: `GET /audit/evidence?from&to` (sha256-signed) | ☐ DPO: __________ Date: ____ |
| 7 | Livestock movement & trade | **State/federal livestock movement permit obligations**; disease-control (traceability) regulations under the animal-health authorities | `livestock-health` module (`movement_permits`, `movements`, `recalls`); migration `013_livestock_health.sql` | ☐ Counsel: __________ Date: ____ |
| 8 | Livestock insurance referrals | **NAICOM** — platform does NOT sell/underwrite insurance; referral-only stance must be confirmed (n/a if purely referential) | `livestock-trade` module insurance policy/claim records (`LIVESTOCK_INSURANCE_PROVIDER` fail-closed stub) | ☐ Counsel: __________ Date: ____ |
| 9 | Marketplace consumer protection | **FCCPA 2018** — refund rights, misleading-listing prohibitions, complaint handling | Returns flow (`return_requests` repository); review/rating moderation | ☐ Counsel: __________ Date: ____ |
| 10 | Credit readiness / lending referrals | CBN consumer-protection framework; money-lending licences are state-level — referral model must be confirmed | `finance` module (credit profiles, loan applications, lender registry) | ☐ Counsel: __________ Date: ____ |
| 11 | SMS/WhatsApp/USSD communications | NCC regulations + NDPA consent for direct marketing | Channel-level notification preferences + consent records; delivery logs purged after 365 days | ☐ DPO: __________ Date: ____ |
| 12 | Cross-border data transfers (OIDC, cloud, WhatsApp) | NDPA ss.41–43 (adequacy/safeguards) | `docs/security-compliance.md`; processors list in DPIA §1 | ☐ Counsel: __________ Date: ____ |

## Process

1. Engineering keeps the code-evidence pointers current as features change.
2. The DPO/counsel works through this checklist per release train; **no checkbox may be
   ticked by engineering**.
3. Completed checklists are stored with the release's compliance evidence pack
   (`GET /audit/evidence` output attached).
