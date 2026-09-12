-- 059_fraud_sentinel.sql — Stage 27 innovation "Float Sentinel" (fraud schema).
-- Deterministic fraud/liquidity anomaly engine over the single-ledger outbox
-- stream: versioned rule registry, an alert queue with dedup-keyed upserts,
-- and an admin case queue. The sentinel is a DETECTIVE control only — it
-- never blocks money movement; every rule firing lands as an alert row for a
-- human officer.
--
-- Idempotent per repo policy (IF NOT EXISTS, ON CONFLICT DO NOTHING seeds).
-- No triggers, per repo convention (application code maintains timestamps).
-- Rule versions are IMMUTABLE: tuning a rule inserts a new (code, version)
-- row; the service layer exposes no UPDATE of params on an existing version.

BEGIN;

CREATE SCHEMA IF NOT EXISTS fraud;

-- Versioned deterministic rule registry. (code, version) is the natural key;
-- params holds the rule's full threshold set as jsonb so every alert can name
-- the exact parameter set that fired it. Seeded below with the v1 catalog;
-- `enabled` lets operators toggle rules individually (the module-level
-- `float-sentinel` feature flag gates the whole engine and defaults OFF).
CREATE TABLE IF NOT EXISTS fraud.rules (
    code         text NOT NULL,
    version      integer NOT NULL,
    description  text NOT NULL,
    params       jsonb NOT NULL,
    enabled      boolean NOT NULL DEFAULT true,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (code, version)
);

-- Alert queue. One row per (rule, version, firing event, subject) — dedup_key
-- is UNIQUE and the service upserts ON CONFLICT DO NOTHING, so replaying the
-- outbox (mark-after consumer doctrine) can never double-alert. evidence
-- carries the contributing event ids + computed values so a reviewer can
-- re-derive the firing by hand (transparent rule basis).
CREATE TABLE IF NOT EXISTS fraud.alerts (
    id            text PRIMARY KEY,
    dedup_key     text NOT NULL,
    rule_code     text NOT NULL,
    rule_version  integer NOT NULL,
    subject_type  text NOT NULL CHECK (subject_type IN ('agent','voucher','account')),
    subject_id    text NOT NULL,
    severity      text NOT NULL CHECK (severity IN ('low','medium','high')),
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
    evidence      jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz,
    resolved_by   text,
    resolution    text
);

CREATE UNIQUE INDEX IF NOT EXISTS fraud_alerts_dedup_key_idx
    ON fraud.alerts (dedup_key);

CREATE INDEX IF NOT EXISTS fraud_alerts_status_idx
    ON fraud.alerts (status, created_at);

CREATE INDEX IF NOT EXISTS fraud_alerts_rule_idx
    ON fraud.alerts (rule_code);

CREATE INDEX IF NOT EXISTS fraud_alerts_subject_idx
    ON fraud.alerts (subject_type, subject_id);

-- Admin case queue: groups alerts for one officer with a resolution trail.
-- alert_ids is a snapshot of the alert ids grouped into the case; the alerts
-- themselves keep their own lifecycle.
CREATE TABLE IF NOT EXISTS fraud.cases (
    id          text PRIMARY KEY,
    alert_ids   text[] NOT NULL,
    assignee    text,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    resolution  text,
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by text
);

CREATE INDEX IF NOT EXISTS fraud_cases_status_idx
    ON fraud.cases (status, created_at);

-- v1 rule catalog (deterministic, pure functions of the outbox stream; see
-- apps/api/src/modules/fraud/rules.ts for the evaluators and the handoff for
-- the threshold rationale). Idempotent seed.
INSERT INTO fraud.rules (code, version, description, params, enabled, created_by)
VALUES
    (
        'agent_daily_velocity', 1,
        'Agent same-day cash-out volume/count far above the agent''s own trailing-90-day p95 baseline, or above the configured daily limit (limit-bypass signal).',
        '{"maxDailyTransactions":40,"baselineDays":90,"volumeMultiplier":4,"minBaselineDays":5,"minDailyTotalKobo":500000000}'::jsonb,
        true, 'migration-059'
    ),
    (
        'structuring_below_limit', 1,
        'Three or more same-day agent transactions each within 2% below the agent''s configured daily limit (structuring pattern).',
        '{"minTransactions":3,"withinPctOfLimit":2}'::jsonb,
        true, 'migration-059'
    ),
    (
        'voucher_redemption_cluster', 1,
        'Voucher redemptions clustering at one supplier across >=3 distinct farmers within 1h, or a farmer redeeming twice in the same programme within 1h (replay).',
        '{"windowMinutes":60,"minDistinctFarmers":3,"maxRedemptionsPerFarmerProgramme":1}'::jsonb,
        true, 'migration-059'
    ),
    (
        'float_cycle_wash', 1,
        'Agent deposits and withdrawals netting <1% over a rolling 24h with material gross volume (float wash / cycling).',
        '{"windowHours":24,"maxNetRatioPct":1,"minGrossKobo":100000000,"minTransactions":6}'::jsonb,
        true, 'migration-059'
    ),
    (
        'dormancy_burst', 1,
        'Agent inactive >=30 days then transacts far above its own historical p99 amount (account-takeover / sleeper pattern).',
        '{"dormantDays":30,"minBurstKobo":200000000,"burstMultiplier":3}'::jsonb,
        true, 'migration-059'
    ),
    (
        'float_depletion', 1,
        'Agent ledger float balance crosses at-or-below the agent''s configured low-float threshold (liquidity early warning).',
        '{}'::jsonb,
        true, 'migration-059'
    ),
    (
        'duplicate_amount_burst', 1,
        'Three or more identical-amount transactions at one agent within 30 minutes (replay / scripting pattern).',
        '{"windowMinutes":30,"minCount":3}'::jsonb,
        true, 'migration-059'
    )
ON CONFLICT (code, version) DO NOTHING;

COMMIT;
