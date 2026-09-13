-- 073_agent_float_forecast.sql — Stage 27 Innovation 15 "Float Forecaster"
-- (agent_banking schema).
--
-- Deterministic agent-float forecasting over ledger-derived daily net flows
-- (weekday seasonal naive + trend, model_version pinned per row — no ML in
-- v1) plus the network-ops rebalancing alert queue. The forecaster is
-- strictly READ-ONLY on the ledger: these tables hold operational forecast
-- and alert records only; no money movement is possible through them.
--
-- Dedupe doctrine: at most ONE open alert per agent per alert type, enforced
-- by a partial unique index so a nightly re-run refreshes forecasts without
-- spamming the ops queue (alert threshold crossing fires exactly once while
-- a human has not yet acknowledged/resolved it).
--
-- Fail-closed on thin data: agents with < 14 days of ledger history get a
-- forecast row marked basis='insufficient_history' (day_offset 0 marker,
-- predictions carry the current float verbatim) and NO alert is raised from
-- it — a wrong depletion alert sends an ops run to the wrong village.
--
-- Idempotent per repo policy (IF NOT EXISTS). No triggers — updated_at is
-- maintained by application code, per repo convention.

BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_banking;

-- Rebalance run: groups claimed open alerts into one ops route batch.
CREATE TABLE IF NOT EXISTS agent_banking.rebalance_runs (
    id              text PRIMARY KEY,
    status          text NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned','dispatched','completed','cancelled')),
    alert_count     integer NOT NULL DEFAULT 0 CHECK (alert_count >= 0),
    notes           text,
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per (agent, run date, forecast day): the predicted net flow and
-- end-of-day float for target_date, computed as of forecast_date.
-- model_version is part of the rerun-identity UNIQUE key so a future model
-- never silently rewrites a prior model's rows (immutable-version doctrine).
CREATE TABLE IF NOT EXISTS agent_banking.float_forecasts (
    id                          text PRIMARY KEY,
    agent_id                    text NOT NULL REFERENCES agent_banking.agents(id),
    forecast_date               date NOT NULL,
    day_offset                  integer NOT NULL CHECK (day_offset >= 0),
    target_date                 date NOT NULL,
    horizon_days                integer NOT NULL CHECK (horizon_days > 0),
    predicted_net_flow_kobo     bigint NOT NULL,
    predicted_eod_float_kobo    bigint NOT NULL,
    basis                       text NOT NULL
                                CHECK (basis IN ('seasonal_trend','insufficient_history')),
    model_version               text NOT NULL,
    computed_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, forecast_date, day_offset, model_version)
);

CREATE INDEX IF NOT EXISTS float_forecasts_agent_date_idx
    ON agent_banking.float_forecasts (agent_id, forecast_date);

-- Ops alert queue. Status machine: open -> acknowledged -> resolved
-- (resolve directly from open is also allowed); every transition is a
-- guarded CAS in the repository so concurrent acks surface as 409.
CREATE TABLE IF NOT EXISTS agent_banking.rebalance_alerts (
    id                          text PRIMARY KEY,
    agent_id                    text NOT NULL REFERENCES agent_banking.agents(id),
    alert_type                  text NOT NULL CHECK (alert_type IN ('depletion','excess')),
    predicted_breach_at         date NOT NULL,
    predicted_eod_float_kobo    bigint NOT NULL,
    threshold_kobo              bigint NOT NULL,
    status                      text NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','acknowledged','resolved')),
    run_id                      text REFERENCES agent_banking.rebalance_runs(id),
    model_version               text NOT NULL,
    acknowledged_by             text,
    acknowledged_at             timestamptz,
    resolved_by                 text,
    resolved_at                 timestamptz,
    resolution                  text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- One OPEN alert per agent per type: the nightly run may re-predict the same
-- breach, but the queue holds exactly one open row for it (dedupe).
CREATE UNIQUE INDEX IF NOT EXISTS rebalance_alerts_one_open_per_agent_type
    ON agent_banking.rebalance_alerts (agent_id, alert_type) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS rebalance_alerts_status_idx
    ON agent_banking.rebalance_alerts (status);

CREATE INDEX IF NOT EXISTS rebalance_alerts_run_idx
    ON agent_banking.rebalance_alerts (run_id);

COMMIT;
