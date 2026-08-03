# Data Protection Impact Assessment (DPIA) — Template

> **Template prepared for qualified Nigerian legal review — not legal advice, not reviewed, not signed off.**
> NDPA 2023 requires a DPIA for processing likely to result in high risk to data subjects
> (e.g. large-scale profiling, sensitive data, vulnerable subjects such as rural farmers with
> limited literacy). This template must be completed and signed by a qualified DPO/lawyer.

## 1. Processing overview (fill per feature)

| Field | Content |
|---|---|
| Feature / system | <!-- e.g. Marketplace escrow, credit-readiness scoring, livestock traceability --> |
| Data controller | <!-- legal entity name + NDPC registration number (see legal-review-checklist.md) --> |
| DPO contact | <!-- name, email, phone --> |
| Data categories | <!-- from ndpa-data-inventory.md --> |
| Data subjects | <!-- farmers, buyers, partners, vets, chapter leads --> |
| Recipients / processors | <!-- payment providers, Keycloak, WhatsApp BSP, lenders --> |
| Cross-border transfers | <!-- yes/no + safeguards --> |
| Retention | <!-- from retention-policy.md --> |

## 2. Necessity and proportionality

- [ ] Purpose is specific, legitimate and documented (link to inventory row)
- [ ] Data minimisation reviewed — every collected field is justified
- [ ] Lawful basis identified per purpose (NDPA s.25)
- [ ] Consent capture is granular, versioned and revocable
      (code: `POST /compliance/consents`, `DELETE /compliance/consents/:purpose`)
- [ ] Data-subject rights workflow tested (export: `POST /compliance/dsr/export`;
      erasure: `POST /compliance/dsr/erasure` + admin approval)

## 3. Risk assessment

| Risk to data subjects | Likelihood (H/M/L) | Severity (H/M/L) | Mitigation (code pointer) | Residual risk | Owner |
|---|---|---|---|---|---|
| Account takeover via shared devices | <!-- --> | <!-- --> | PIN profiles, session-family revocation | | |
| Unauthorised admin access to PII | | | RBAC + hash-chained audit log + `GET /audit/evidence` | | |
| Re-identification after erasure | | | Tombstone pseudonymisation (`redacted:<sha256>`), financial rows kept detached from PII | | |
| Payment-data exposure in escrow flows | | | Provider-hosted payment pages, no PAN storage (confirm!) | | |
| Livestock location tracking misuse | | | Role-gated access (TEMPLATE — confirm) | | |
| Excessive notification profiling | | | Channel-level opt-in consent, 365-day purge | | |

## 4. Consultation

- [ ] Data subjects / farmer representatives consulted (date, method, outcome)
- [ ] DPO consulted (name, date)
- [ ] Processors' NDPA/SCC-equivalent terms reviewed (list)

## 5. Sign-off (HUMAN — never fabricate)

| Role | Name | Signature | Date |
|---|---|---|---|
| DPO | | | |
| Legal counsel (Nigeria) | | | |
| Product owner | | | |

**Status: DRAFT TEMPLATE — unsigned. Do not submit to the NDPC in this form.**
