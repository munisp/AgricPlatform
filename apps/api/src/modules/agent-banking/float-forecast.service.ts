import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  FLOAT_FORECAST_REPOSITORY,
  REBALANCE_ALERT_REPOSITORY,
  REBALANCE_RUN_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AgentBankingAgentRepository, AgentRecord } from '../../database/repositories/agent-banking.repository.js';
import type {
  FloatForecastRecord,
  FloatForecastRepository,
  RebalanceAlertRecord,
  RebalanceAlertRepository,
  RebalanceAlertStatus,
  RebalanceAlertType,
  RebalanceRunRecord,
  RebalanceRunRepository,
  RebalanceRunStatus
} from '../../database/repositories/float-forecast.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import type { BacktestResult } from './float-backtest.js';
import {
  DEFAULT_FORECAST_HORIZON_DAYS,
  FLOAT_FORECAST_MODEL_VERSION,
  densifyDailyFlows,
  fitForecast,
  parseIsoDate,
  type DailyNetFlow,
  type ForecastResult
} from './float-forecast.js';

/** Rollout flag gating the whole forecaster surface (default OFF, fail-closed). */
export const FLOAT_FORECASTER_FLAG = 'float-forecaster';

/**
 * v1 excess heuristic: float above EXCESS_FLOAT_MULTIPLE x the agent's daily
 * limit is dead cash that should be swept back to the platform. Deliberately
 * simple and visible; tuning lands with a future model_version.
 */
export const EXCESS_FLOAT_MULTIPLE = 3;

// Telemetry names (Stage-25 <domain>.<noun>_<verb> conventions).
export const FORECAST_RUN_SPAN = 'agent_banking.forecast.run';
export const REBALANCE_ALERTS_TOTAL = 'agent_banking.rebalance_alerts_total';
export const FORECAST_RUNS_TOTAL = 'agent_banking.forecast_runs_total';
export const FORECAST_MAPE_BPS = 'agent_banking.forecast_mape_bps';
export const FORECAST_DEPLETION_HIT_RATE_BPS = 'agent_banking.forecast_depletion_hit_rate_bps';

export interface ForecastRunInput {
  /** ISO day to forecast as-of; defaults to today (UTC). Tests pin it. */
  asOfDate?: string;
  horizonDays?: number;
}

export interface ForecastRunSummary {
  modelVersion: string;
  asOfDate: string;
  horizonDays: number;
  agentsEvaluated: number;
  agentsWithInsufficientHistory: number;
  forecastRowsWritten: number;
  alertsRaised: number;
  /** Open alerts already queued were refreshed in place, never duplicated. */
  alertsDeduplicated: number;
}

export interface AlertQuery {
  status?: RebalanceAlertStatus;
  agentId?: string;
}

/**
 * Float Forecaster service (Stage 27, Innovation 15). READ-ONLY on the
 * ledger: daily net flows are derived from the float account's journal
 * entries (the same source as the daily reconciliation export), forecasts
 * and alerts land in the agent_banking schema, and dispatch stays human —
 * nothing here moves money.
 */
@Injectable()
export class FloatForecastService {
  private readonly telemetry: TelemetryService;

  constructor(
    @Inject(AGENT_BANKING_AGENT_REPOSITORY) private readonly agents: AgentBankingAgentRepository,
    @Inject(FLOAT_FORECAST_REPOSITORY) private readonly forecasts: FloatForecastRepository,
    @Inject(REBALANCE_ALERT_REPOSITORY) private readonly alerts: RebalanceAlertRepository,
    @Inject(REBALANCE_RUN_REPOSITORY) private readonly runs: RebalanceRunRepository,
    private readonly ledger: LedgerService,
    private readonly events: DomainEventsService,
    @Optional() telemetry?: TelemetryService
  ) {
    // No-op-safe fallback for direct construction (unit tests), mirroring
    // DomainEventsService: with the SDK disabled every helper is a near-free
    // no-op and never throws.
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /**
   * Ledger-derived dense daily net-flow series for an agent's float account,
   * covering the first posting up to (excluding) asOfDate. Debit-positive,
   * matching AgentBankingService.reconciliation's floatDelta convention.
   * Float top-up legs (referenceType 'agent_banking_float_topup') are
   * EXCLUDED: rebalancing is an ops intervention, not organic flow, and a
   * top-up spike would otherwise poison the trend. The current float level
   * still comes from the ledger balance, which includes every posting.
   */
  async dailyNetFlows(agent: AgentRecord, asOfDate: string): Promise<DailyNetFlow[]> {
    const entries = await this.ledger.entriesForAccount(agent.floatAccountCode);
    const byDay = new Map<string, number>();
    for (const entry of entries) {
      if (entry.referenceType === 'agent_banking_float_topup') {
        continue;
      }
      const day = entry.postedAt.slice(0, 10);
      if (day >= asOfDate) {
        continue; // the as-of day is partial; only full days train the model
      }
      let delta = 0;
      for (const posting of entry.postings) {
        if (posting.accountCode !== agent.floatAccountCode) continue;
        delta += posting.direction === 'debit' ? posting.amountKobo : -posting.amountKobo;
      }
      byDay.set(day, (byDay.get(day) ?? 0) + delta);
    }
    const sparse = [...byDay.entries()]
      .map(([date, netFlowKobo]) => ({ date, netFlowKobo }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return densifyDailyFlows(sparse);
  }

  /**
   * One forecasting pass over all ACTIVE agents — the nightly scheduler hook
   * (external cron/CronJob calls POST forecast/run, same convention as the
   * analytics projector). Rerun-idempotent for the same as-of date: forecast
   * rows upsert on (agent, date, offset, model_version) and a re-predicted
   * breach hits the one-open-alert dedupe instead of spamming the queue.
   */
  async run(input: ForecastRunInput = {}, actorId = 'system'): Promise<ForecastRunSummary> {
    const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
    const horizonDays = input.horizonDays ?? DEFAULT_FORECAST_HORIZON_DAYS;
    try {
      parseIsoDate(asOfDate);
    } catch {
      throw new BadRequestException('asOfDate must be YYYY-MM-DD');
    }
    const agents = await this.agents.find({ status: 'ACTIVE' });
    return this.telemetry.withSpan(
      FORECAST_RUN_SPAN,
      { agent_count: agents.length, model_version: FLOAT_FORECAST_MODEL_VERSION },
      async () => {
        const summary: ForecastRunSummary = {
          modelVersion: FLOAT_FORECAST_MODEL_VERSION,
          asOfDate,
          horizonDays,
          agentsEvaluated: 0,
          agentsWithInsufficientHistory: 0,
          forecastRowsWritten: 0,
          alertsRaised: 0,
          alertsDeduplicated: 0
        };
        for (const agent of agents) {
          summary.agentsEvaluated += 1;
          const history = await this.dailyNetFlows(agent, asOfDate);
          const balance = await this.ledger.balance(agent.floatAccountCode);
          const forecast = fitForecast({
            history,
            asOfDate,
            horizonDays,
            currentFloatKobo: balance.balanceKobo,
            depletionThresholdKobo: agent.lowFloatThresholdKobo,
            excessThresholdKobo: agent.dailyLimitKobo * EXCESS_FLOAT_MULTIPLE
          });
          summary.forecastRowsWritten += await this.persistForecast(agent, forecast);
          if (forecast.basis === 'insufficient_history') {
            summary.agentsWithInsufficientHistory += 1;
          }
          await this.events.publish(
            'agent_banking.forecast.computed',
            {
              agentId: agent.id,
              asOfDate,
              basis: forecast.basis,
              historyDays: forecast.historyDays,
              modelVersion: forecast.modelVersion,
              ...(forecast.depletionDate ? { depletionDate: forecast.depletionDate } : {}),
              ...(forecast.excessDate ? { excessDate: forecast.excessDate } : {})
            },
            actorId
          );
          if (forecast.basis !== 'seasonal_trend') {
            continue; // fail closed: no alert from thin history
          }
          const depletion = forecast.depletionDate
            ? await this.raiseAlert(agent, 'depletion', forecast, forecast.depletionDate, actorId)
            : 'none';
          const excess = forecast.excessDate
            ? await this.raiseAlert(agent, 'excess', forecast, forecast.excessDate, actorId)
            : 'none';
          for (const outcome of [depletion, excess]) {
            if (outcome === 'raised') summary.alertsRaised += 1;
            if (outcome === 'deduplicated') summary.alertsDeduplicated += 1;
          }
        }
        this.telemetry.increment(FORECAST_RUNS_TOTAL, 1, {
          model_version: FLOAT_FORECAST_MODEL_VERSION
        });
        return summary;
      }
    );
  }

  private async persistForecast(agent: AgentRecord, forecast: ForecastResult): Promise<number> {
    const computedAt = new Date().toISOString();
    if (forecast.basis === 'insufficient_history') {
      // Marker row (day_offset 0): records WHY there is no forecast. The
      // prediction fields carry the current float verbatim — not a forecast.
      await this.forecasts.upsert({
        id: newId('forecast'),
        agentId: agent.id,
        forecastDate: forecast.asOfDate,
        dayOffset: 0,
        targetDate: forecast.asOfDate,
        horizonDays: forecast.horizonDays,
        predictedNetFlowKobo: 0,
        predictedEodFloatKobo: forecast.currentFloatKobo,
        basis: forecast.basis,
        modelVersion: forecast.modelVersion,
        computedAt
      });
      return 1;
    }
    for (const prediction of forecast.predictions) {
      await this.forecasts.upsert({
        id: newId('forecast'),
        agentId: agent.id,
        forecastDate: forecast.asOfDate,
        dayOffset: prediction.dayOffset,
        targetDate: prediction.targetDate,
        horizonDays: forecast.horizonDays,
        predictedNetFlowKobo: prediction.predictedNetFlowKobo,
        predictedEodFloatKobo: prediction.predictedEodFloatKobo,
        basis: forecast.basis,
        modelVersion: forecast.modelVersion,
        computedAt
      });
    }
    return forecast.predictions.length;
  }

  /**
   * Raises an alert unless one is already open for (agent, type) — the
   * partial unique index (and its in-memory mirror) makes the threshold
   * crossing fire exactly once until a human acks/resolves it.
   */
  private async raiseAlert(
    agent: AgentRecord,
    type: RebalanceAlertType,
    forecast: ForecastResult,
    breachDate: string,
    actorId: string
  ): Promise<'raised' | 'deduplicated'> {
    const prediction = forecast.predictions.find((row) => row.targetDate === breachDate);
    const now = new Date().toISOString();
    try {
      const alert = await this.alerts.create({
        id: newId('alert'),
        agentId: agent.id,
        alertType: type,
        predictedBreachAt: breachDate,
        predictedEodFloatKobo: prediction?.predictedEodFloatKobo ?? forecast.currentFloatKobo,
        thresholdKobo:
          type === 'depletion'
            ? agent.lowFloatThresholdKobo
            : agent.dailyLimitKobo * EXCESS_FLOAT_MULTIPLE,
        status: 'open',
        modelVersion: forecast.modelVersion,
        createdAt: now,
        updatedAt: now
      });
      this.telemetry.increment(REBALANCE_ALERTS_TOTAL, 1, { type });
      await this.events.publish(
        'agent_banking.rebalance_alert.raised',
        {
          alertId: alert.id,
          agentId: agent.id,
          alertType: type,
          predictedBreachAt: breachDate,
          modelVersion: forecast.modelVersion
        },
        actorId
      );
      return 'raised';
    } catch (error) {
      if (error instanceof ConflictException) {
        return 'deduplicated'; // already queued for ops — refresh is a no-op
      }
      throw error;
    }
  }

  async listForecasts(filter: { agentId?: string }): Promise<FloatForecastRecord[]> {
    return this.forecasts.find({ ...(filter.agentId ? { agentId: filter.agentId } : {}) });
  }

  async listAlerts(query: AlertQuery): Promise<RebalanceAlertRecord[]> {
    return this.alerts.find({
      ...(query.status ? { status: query.status } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {})
    });
  }

  /** open -> acknowledged, guarded CAS; anything else is a 409. */
  async acknowledgeAlert(id: string, actorId: string): Promise<RebalanceAlertRecord> {
    const alert = await this.alerts.findById(id);
    if (!alert) {
      throw new NotFoundException(`Rebalance alert '${id}' not found`);
    }
    if (alert.status !== 'open') {
      throw new ConflictException(`Rebalance alert '${id}' is ${alert.status}, not open`);
    }
    const now = new Date().toISOString();
    return this.alerts.updateExpected(
      id,
      { status: 'acknowledged', acknowledgedBy: actorId, acknowledgedAt: now, updatedAt: now },
      { status: 'open' }
    );
  }

  /** open|acknowledged -> resolved, guarded CAS; already-resolved is a 409. */
  async resolveAlert(id: string, actorId: string, resolution?: string): Promise<RebalanceAlertRecord> {
    const alert = await this.alerts.findById(id);
    if (!alert) {
      throw new NotFoundException(`Rebalance alert '${id}' not found`);
    }
    if (alert.status === 'resolved') {
      throw new ConflictException(`Rebalance alert '${id}' is already resolved`);
    }
    const now = new Date().toISOString();
    const resolved = await this.alerts.updateExpected(
      id,
      {
        status: 'resolved',
        resolvedBy: actorId,
        resolvedAt: now,
        ...(resolution ? { resolution } : {}),
        updatedAt: now
      },
      { status: alert.status }
    );
    await this.events.publish(
      'agent_banking.rebalance_alert.resolved',
      { alertId: id, agentId: alert.agentId, alertType: alert.alertType },
      actorId
    );
    return resolved;
  }

  /**
   * Groups open alerts into one ops route batch. Each alert is claimed with
   * a guarded write (open AND unclaimed) so an alert can never ride two
   * runs; all alerts are validated before the run row exists, so a rejected
   * claim leaves no orphan run.
   */
  async createRun(alertIds: string[], actorId: string, notes?: string): Promise<RebalanceRunRecord> {
    const uniqueIds = [...new Set(alertIds)];
    if (uniqueIds.length === 0) {
      throw new BadRequestException('alertIds must not be empty');
    }
    const alerts: RebalanceAlertRecord[] = [];
    for (const alertId of uniqueIds) {
      const alert = await this.alerts.findById(alertId);
      if (!alert) {
        throw new NotFoundException(`Rebalance alert '${alertId}' not found`);
      }
      if (alert.status !== 'open' || alert.runId !== undefined) {
        throw new ConflictException(`Rebalance alert '${alertId}' is not an unclaimed open alert`);
      }
      alerts.push(alert);
    }
    const now = new Date().toISOString();
    const run = await this.runs.create({
      id: newId('run'),
      status: 'planned',
      alertCount: uniqueIds.length,
      ...(notes ? { notes } : {}),
      createdBy: actorId,
      createdAt: now,
      updatedAt: now
    });
    for (const alert of alerts) {
      await this.alerts.claimForRun(alert.id, run.id, new Date().toISOString());
    }
    return run;
  }

  async listRuns(filter: { status?: RebalanceRunStatus }): Promise<RebalanceRunRecord[]> {
    return this.runs.find({ ...(filter.status ? { status: filter.status } : {}) });
  }

  /**
   * Emits backtest accuracy metrics per model_version (gauge histogram
   * agent_banking.forecast_mape_bps + the depletion hit-rate). Called by the
   * backtest harness — accuracy numbers are always produced by the harness
   * first, never asserted without one.
   */
  publishBacktestMetrics(result: BacktestResult): void {
    const attributes = { model_version: result.modelVersion };
    if (result.mapeBps !== null) {
      this.telemetry.record(FORECAST_MAPE_BPS, result.mapeBps, attributes);
    }
    if (result.depletionHitRateBps !== null) {
      this.telemetry.record(FORECAST_DEPLETION_HIT_RATE_BPS, result.depletionHitRateBps, attributes);
    }
  }
}
