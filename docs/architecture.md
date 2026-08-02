# AgricPlatform — Implemented Architecture

**As implemented:** main @ Stage 10 (PRD v3.3 full build-out, waves P1–P6). 993 automated tests green, 11 SQL migrations, fail-closed provider layer.

This document describes what is **actually implemented in the repository**, not the target-state proposal in the PRD. External systems are shown dashed; adapters are stub-by-default and fail closed in production without credentials.

---

## 1. System context

```mermaid
flowchart LR
    subgraph Users
        F[Young farmer<br/>PWA / mobile / USSD / IVR / WhatsApp]
        CL[Chapter lead]
        AD[NYFN admin]
        PT[Partner: DFI / lender / NGO]
        DV[External developer]
    end

    subgraph Platform[NYFN Platform]
        WEB[Next.js PWA]
        MOB[Expo mobile shell]
        API[NestJS API]
        SDKpkg["@agric-platform/sdk"]
    end

    subgraph External[External systems - credential gated]
        KC[Keycloak IdP]
        T[Termii / Twilio SMS]
        W[360dialog WhatsApp]
        MG[Mailgun / SendGrid]
        OS[OneSignal]
        PS[Paystack / Flutterwave]
        AT[Africa's Talking USSD + Voice]
        OM[Open-Meteo - keyless live]
        FEEDS[FEWS NET / NiMet / NCX / AFEX]
        FARM[farmOS / LiteFarm / OFN]
        ODK[ODK / KoboToolbox]
        EXT[e-Extension NAERLS/FMARD]
        MS[Meilisearch]
    end

    F --> WEB & MOB
    CL --> WEB
    AD --> WEB
    PT -->|Partner API| API
    DV --> SDKpkg --> API
    WEB & MOB --> API
    API -.-> KC & T & W & MG & OS & PS & AT & FEEDS & FARM & ODK & EXT & MS
    API --> OM
```

## 2. Container view (deployed units)

```mermaid
flowchart TB
    subgraph Edge
        CDN[CDN / static assets + widget bundles]
    end

    subgraph Clients
        PWA["apps/web - Next.js 16 PWA<br/>SSR, service worker v3, IndexedDB drafts,<br/>replayable offline queue, i18n scaffold"]
        MOBILE["apps/mobile - Expo/RN shell<br/>typed client, offline queue"]
        WIDGETS["public/widgets/*.js<br/>4 embeddable bundles, CORS, no PII"]
        SDK["packages/sdk - ESM+CJS client"]
    end

    subgraph Server["API service (apps/api, NestJS 11 ESM)"]
        GW["Global layer<br/>OIDC/JWKS auth · RBAC guards · throttler<br/>idempotency interceptor (Redis 24h)<br/>pino request-id · Prometheus /metrics"]
        MODS["28 feature modules<br/>(see module map)"]
        PORTS["Async repository ports<br/>61 providers: in-memory | pg"]
        DRV["Provider driver layer<br/>stub default · fail-closed production"]
    end

    subgraph Data
        PG[(PostgreSQL<br/>11 migrations · 9 schemas)]
        RD[(Redis<br/>idempotency · OTP · cache · KV)]
    end

    PWA & MOBILE & WIDGETS & SDK --> GW
    GW --> MODS --> PORTS
    MODS --> DRV
    PORTS --> PG
    GW --> RD
    DRV -.->|credential gated| EXT[External providers]
    CDN --> PWA
```

## 3. Module map (18 PRD modules → implementation)

```mermaid
flowchart LR
    subgraph Identity["M1 · M18"]
        AUTH[auth<br/>OTP · OIDC/JWKS · PIN swap]
        USERS[users + profiles<br/>roles · KYC tiers · completion score]
        PRIV[privacy<br/>NDPR consent · export · delete]
    end

    subgraph Engagement["M2 · M3 · M4 · M10 · M11 · M12 · M14"]
        DASH[dashboard]
        COMM[community + Discourse bridge]
        LEARN[learning + Moodle bridge<br/>certificates]
        CHAP[chapters<br/>hierarchy · events · QR attendance]
        PROG[programmes<br/>cohorts · judging · protected spaces]
        PATH[pathways<br/>STUDENT/NYSC · campus clubs]
        KNOW[knowledge<br/>library · podcasts+transcripts · webinars]
    end

    subgraph Commerce["M5 · M6 · M7 · M8 · M9"]
        ADV[advisory<br/>crop calendar · weather · prices]
        OPP[opportunities]
        MKT[marketplace<br/>orders · escrow · invoices · shipments]
        SVC[services-marketplace<br/>suppliers · bookings · reviews]
        FIN[finance<br/>double-entry ledger · credit · lenders · loans]
    end

    subgraph Platform["M13 · M15 · M16 · M17"]
        ANA[analytics<br/>KPIs · exports · marts · funnels · retention]
        NOTIF[notifications<br/>4 channels · preferences]
        SRCH[search<br/>trending · related · recommendations]
        ADMIN[admin + partner<br/>CRM · Partner API · webhooks]
    end

    subgraph Channels["Appendix F channels"]
        USSD[ussd<br/>AT menu engine]
        IVR[ivr<br/>AT voice flows]
        WA[whatsapp workflows<br/>guided chats]
    end

    subgraph Federated["Appendix G - integrations/phase3"]
        ACL[farmOS · OFN · ODK/Kobo<br/>lender API · e-Extension · NCX/AFEX]
    end

    AUTH --> USERS
    MODS_ALL[All modules] -. domain events .-> NOTIF
    FIN --> MKT
    SRCH --> KNOW & OPP & MKT & LEARN
    ACL --> ADV & FIN & MKT
    USSD & IVR & WA --> USERS & ADV & OPP & LEARN
```

## 4. Provider driver layer (fail-closed contract)

```mermaid
flowchart TB
    SVC[Feature services] --> PORT[IntegrationAdapter port]
    PORT --> STUB["stub driver (default)<br/>local log, no network"]
    PORT --> LIVE["live driver<br/>HTTP via drivers/http.ts<br/>5s AbortController · typed errors"]

    subgraph Gating["Boot-time gating (production)"]
        CHK{"DRIVER=live/sandbox<br/>AND credentials present?"}
        CHK -->|no| THROW["throw ProviderConfigError<br/>process refuses to boot"]
        CHK -->|yes| START[start with live driver]
    end
    LIVE --> Gating

    subgraph Drivers
        D1[Termii+Twilio SMS · 360dialog WA<br/>Mailgun+SendGrid · OneSignal]
        D2[Paystack+Flutterwave<br/>init/verify/refund/escrow-release<br/>webhook HMAC]
        D3[OpenMeteo - live, keyless<br/>+ Redis 15-min cache]
        D4[Meilisearch · Moodle/Discourse/Directus<br/>farmOS · OFN · NCX/AFEX · Kobo/ODK<br/>lender · NAERLS/FMARD · AT USSD/IVR]
    end
    LIVE --> D1 & D2 & D3 & D4
```

## 5. Low-connectivity data flow (Appendix F pattern, as implemented)

```mermaid
sequenceDiagram
    participant U as User (2G/3G)
    participant P as PWA
    participant IDB as IndexedDB (Dexie)
    participant SW as Service Worker
    participant A as API
    participant R as Redis
    participant DB as PostgreSQL

    U->>P: fill registration / listing form
    P->>IDB: autosave draft (debounced keystroke)
    U->>P: submit
    P->>SW: queue mutation (offline) / send (online)
    SW->>A: POST + Idempotency-Key
    A->>R: key lookup (24h TTL)
    alt duplicate key, same body
        R-->>A: replay stored response
    else duplicate key, different body
        R-->>A: 409 mismatch
    else new
        A->>DB: upsert (optimistic lock) + outbox event
        A->>R: store response envelope
    end
    A-->>P: saved / failed (explicit UI state)
    P->>IDB: clear draft on success
    Note over U,A: Feature-phone path: USSD menu / IVR call flow<br/>-> same services, same data model
```

## 6. Persistence overview (11 migrations)

| Migration | Schema / tables | Domain |
| --- | --- | --- |
| 001_init | identity, learning, community, chapters, advisory, marketplace, finance (vault), notifications, analytics, admin — 27 repos | Phase 1 core |
| 002_audit_hash_chain | audit chain columns | Tamper-evident audit |
| 003_commerce_finance | marketplace.escrow_records, invoices, shipments; finance.credit_scores, lenders, loan_applications, repayment_installments; ledger transfers | M7 + M9 |
| 004_engagement | services, programmes, pathways, knowledge, search — 24 tables | M8/M11/M12/M14/M16 |
| 005_attendance_exports | chapters.event_participation scan columns | M10 QR |
| 006_market_data | advisory.commodity_prices | M5 feeds |
| 007_phase3_integrations | integrations.external_account_links, farm_records, import_batches/records, inbound_events | Appendix G |
| 008_ussd_channels | channels.ussd_sessions, pin_profiles | Appendix F |
| 009_analytics_marts | analytics_marts.member_kpis/marketplace/learning_daily | M13 lakehouse handoff |
| 010_partner_api | partners.partner_clients, api_keys, webhook_subscriptions | Partner API/SDK |
| 011_ivr | channels.ivr_calls | IVR (Stage 10) |

## 7. Security & compliance layers

1. **Identity**: Keycloak OIDC/JWKS (jose) bearer verification; hardened OTP (expiry/attempts/lockout); PIN session swap with lockout; dev-header fallback disabled in production.
2. **Access**: RBAC guards per module; ownership-or-admin on sensitive routes; partner scope claims + per-client rate buckets (Redis).
3. **Integrity**: idempotency keys (replay / 409 mismatch), webhook HMAC (platform + Paystack SHA-512 + Flutterwave verif-hash), tamper-evident audit hash chain, signed QR attendance codes (fail-closed secret).
4. **Privacy**: NDPR consent capture, export/delete endpoints, consent-gated federation sharing (denial tested), anonymised lender pushes.
5. **Pipeline**: gitleaks, npm audit (blocking), Trivy, secret-scan clean, CSP/security headers, WCAG AA axe gates, bundle budget 250KB.

## 8. Deployment view

```mermaid
flowchart LR
    subgraph CI["CI gates (required on main)"]
        C1[typecheck · lint · 993 tests]
        C2[lint:sql · bundle budget<br/>gitleaks · audit · Trivy]
        C3[k6 p95<500 gate · Lighthouse a11y≥0.95]
    end
    subgraph K8s["Kubernetes (base + overlays)"]
        S[staging overlay]
        P[production overlay<br/>HPA · PDB · NetworkPolicy<br/>fail-closed env contract]
    end
    subgraph Ops
        BAK[backup/restore scripts<br/>+ CronJob + runbooks]
        MON[Prometheus metrics<br/>pino logs · Sentry env-gated]
    end
    CI --> S --> P
    P --> BAK & MON
```

**Environment contract (fail-closed in production):** `DATABASE_URL`, `REDIS_URL` (no in-memory persistence/cache), Keycloak JWKS, `ATTENDANCE_SIGNING_SECRET`, `PARTNER_API_SIGNING_SECRET`, and any `*_DRIVER=live` flag without its credentials — the process refuses to boot.
