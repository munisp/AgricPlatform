import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryAgentBankingAgentRepository,
  type AgentRecord
} from '../../database/repositories/agent-banking.repository.js';
import {
  createInMemoryFloatForecastRepository,
  createInMemoryRebalanceAlertRepository,
  createInMemoryRebalanceRunRepository
} from '../../database/repositories/float-forecast.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository,
  type InMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  EXCESS_FLOAT_MULTIPLE,
  FloatForecastService
} from './float-forecast.service.js';
import { FLOAT_FORECAST_MODEL_VERSION, addDays } from './float-forecast.js';

/**
 * Service-level tests over in-memory repositories. Ledger history is seeded
 * with backdated journal entries straight into the entry repository (the
 * LedgerService stamps postedAt=now by design), mirroring how the nightly
 * run reads a real agent's posting history.
 */

const AS_OF = '2026-01-18'; // Sunday; history covers Sun 2026-01-04 .. Sat 2026-01-17.
const OPS = 'user-ops-admin';

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const id = overrides.id ?? 'agent-1';
  return {
    id,
    userId: `user-${id}`,
    organisation: 'Kano Farmers Cooperative',
    status: 'ACTIVE',
    floatAccountCode: `agent:${id}:float`,
    commissionAccountCode: `agent:${id}:commission_payable`,
    dailyLimitKobo: 10_000_000,
    lowFloatThresholdKobo: 100_000,
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    ...overrides
  };
}

let entrySeq = 0;
function seedEntry(
  entries: InMemoryLedgerEntryRepository,
  floatAccountCode: string,
  day: string,
  deltaKobo: number,
  referenceType: string
): Promise<LedgerJournalEntry> {
  entrySeq += 1;
  const amount = Math.abs(deltaKobo);
  return entries.postEntry({
    id: `entry-${entrySeq}`,
    idempotencyKey: `seed-${entrySeq}`,
    referenceType,
    postedAt: `${day}T09:00:00.000Z`,
    postings: [
      {
        accountCode: floatAccountCode,
        direction: deltaKobo >= 0 ? 'debit' : 'credit',
        amountKobo: amount
      },
      {
        accountCode: 'platform:cash',
        direction: deltaKobo >= 0 ? 'credit' : 'debit',
        amountKobo: amount
      }
    ]
  });
}

async function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const entryRepo = createInMemoryLedgerEntryRepository();
  const ledger = new LedgerService(events, createInMemoryLedgerAccountRepository(), entryRepo);
  const agents = createInMemoryAgentBankingAgentRepository();
  const forecasts = createInMemoryFloatForecastRepository();
  const alerts = createInMemoryRebalanceAlertRepository();
  const runs = createInMemoryRebalanceRunRepository();
  const service = new FloatForecastService(agents, forecasts, alerts, runs, ledger, events);
  const published: string[] = [];
  events.on('*', (event: { name: string }) => published.push(event.name));
  return { service, events, entryRepo, ledger, agents, forecasts, alerts, runs, published };
}

/** Depletion agent: N500/day organic drain; float funded via one top-up. */
async function seedDepletionAgent(ctx: Awaited<ReturnType<typeof makeService>>) {
  const agent = await ctx.agents.create(agentRecord({ id: 'agent-deplete' }));
  await ctx.ledger.ensureAccount({ code: agent.floatAccountCode, type: 'asset' });
  // Top-ups are ops interventions: excluded from training, included in balance.
  await seedEntry(ctx.entryRepo, agent.floatAccountCode, '2026-01-03', 1_000_000, 'agent_banking_float_topup');
  for (let day = 4; day <= 17; day += 1) {
    await seedEntry(
      ctx.entryRepo,
      agent.floatAccountCode,
      `2026-01-${String(day).padStart(2, '0')}`,
      -50_000,
      'agent_banking_cash_in'
    );
  }
  return agent; // currentFloat = 1_000_000 - 14 * 50_000 = 300_000
}

/** Excess agent: N2,000/day organic inflow on a large funded float. */
async function seedExcessAgent(ctx: Awaited<ReturnType<typeof makeService>>) {
  const agent = await ctx.agents.create(
    agentRecord({ id: 'agent-excess', dailyLimitKobo: 5_000_000 })
  );
  await ctx.ledger.ensureAccount({ code: agent.floatAccountCode, type: 'asset' });
  await seedEntry(ctx.entryRepo, agent.floatAccountCode, '2026-01-03', 18_000_000, 'agent_banking_float_topup');
  for (let day = 4; day <= 17; day += 1) {
    await seedEntry(
      ctx.entryRepo,
      agent.floatAccountCode,
      `2026-01-${String(day).padStart(2, '0')}`,
      200_000,
      'agent_banking_cash_out'
    );
  }
  return agent; // currentFloat = 20_800_000; excess threshold = 3 x 5_000_000 = 15_000_000
}

/** Thin-history agent: only 5 organic days — below the 14-day minimum. */
async function seedThinAgent(ctx: Awaited<ReturnType<typeof makeService>>) {
  const agent = await ctx.agents.create(agentRecord({ id: 'agent-thin' }));
  await ctx.ledger.ensureAccount({ code: agent.floatAccountCode, type: 'asset' });
  for (let day = 13; day <= 17; day += 1) {
    await seedEntry(
      ctx.entryRepo,
      agent.floatAccountCode,
      `2026-01-${String(day).padStart(2, '0')}`,
      -10_000,
      'agent_banking_cash_in'
    );
  }
  return agent;
}

describe('FloatForecastService.run', () => {
  it('forecasts known-answer depletion/excess, marks thin history, and publishes events', async () => {
    const ctx = await makeService();
    await seedDepletionAgent(ctx);
    await seedExcessAgent(ctx);
    await seedThinAgent(ctx);

    const summary = await ctx.service.run({ asOfDate: AS_OF }, OPS);
    expect(summary.modelVersion).toBe(FLOAT_FORECAST_MODEL_VERSION);
    expect(summary.agentsEvaluated).toBe(3);
    expect(summary.agentsWithInsufficientHistory).toBe(1);
    expect(summary.forecastRowsWritten).toBe(14 + 14 + 1);
    expect(summary.alertsRaised).toBe(2);
    expect(summary.alertsDeduplicated).toBe(0);

    // Known-answer depletion: -50_000/day from 300_000 crosses the 100_000
    // threshold exactly on day 4 (2026-01-22, eod = 100_000 <= 100_000).
    const depletionRows = await ctx.forecasts.find({ agentId: 'agent-deplete', forecastDate: AS_OF });
    expect(depletionRows).toHaveLength(14);
    expect(depletionRows[0]).toMatchObject({
      dayOffset: 1,
      targetDate: '2026-01-19',
      predictedNetFlowKobo: -50_000,
      predictedEodFloatKobo: 250_000,
      basis: 'seasonal_trend',
      modelVersion: FLOAT_FORECAST_MODEL_VERSION
    });
    expect(depletionRows[3]).toMatchObject({ targetDate: '2026-01-22', predictedEodFloatKobo: 100_000 });

    const alerts = await ctx.alerts.find({ status: 'open' });
    expect(alerts).toHaveLength(2);
    const depletion = alerts.find((alert) => alert.agentId === 'agent-deplete');
    expect(depletion).toMatchObject({
      alertType: 'depletion',
      predictedBreachAt: '2026-01-22',
      predictedEodFloatKobo: 100_000,
      thresholdKobo: 100_000,
      modelVersion: FLOAT_FORECAST_MODEL_VERSION
    });
    const excess = alerts.find((alert) => alert.agentId === 'agent-excess');
    expect(excess).toMatchObject({
      alertType: 'excess',
      predictedBreachAt: '2026-01-19',
      thresholdKobo: 5_000_000 * EXCESS_FLOAT_MULTIPLE
    });

    // Thin-history agent: exactly one marker row, basis recorded, NO alert.
    const thinRows = await ctx.forecasts.find({ agentId: 'agent-thin' });
    expect(thinRows).toHaveLength(1);
    expect(thinRows[0]).toMatchObject({
      dayOffset: 0,
      basis: 'insufficient_history',
      predictedNetFlowKobo: 0,
      predictedEodFloatKobo: -50_000
    });
    expect(await ctx.alerts.find({ agentId: 'agent-thin' })).toEqual([]);

    // Domain events (outbox): one computed per agent + one raised per alert.
    expect(ctx.published.filter((name) => name === 'agent_banking.forecast.computed')).toHaveLength(3);
    expect(
      ctx.published.filter((name) => name === 'agent_banking.rebalance_alert.raised')
    ).toHaveLength(2);
  });

  it('is rerun-idempotent for the same as-of date: forecasts refresh, alerts dedupe', async () => {
    const ctx = await makeService();
    await seedDepletionAgent(ctx);
    await ctx.service.run({ asOfDate: AS_OF }, OPS);
    const second = await ctx.service.run({ asOfDate: AS_OF }, OPS);
    expect(second.forecastRowsWritten).toBe(14);
    expect(second.alertsRaised).toBe(0);
    expect(second.alertsDeduplicated).toBe(1);
    const rows = await ctx.forecasts.find({ agentId: 'agent-deplete', forecastDate: AS_OF });
    expect(rows).toHaveLength(14); // upserted, not duplicated
    const alerts = await ctx.alerts.find({ agentId: 'agent-deplete', status: 'open' });
    expect(alerts).toHaveLength(1); // threshold crossing fired exactly once
  });

  it('skips non-active agents entirely', async () => {
    const ctx = await makeService();
    await ctx.agents.create(agentRecord({ id: 'agent-pending', status: 'PENDING' }));
    const summary = await ctx.service.run({ asOfDate: AS_OF }, OPS);
    expect(summary.agentsEvaluated).toBe(0);
    expect(await ctx.forecasts.find({ agentId: 'agent-pending' })).toEqual([]);
  });

  it('top-up spikes stay out of the training series but count in the float', async () => {
    const ctx = await makeService();
    const agent = await seedDepletionAgent(ctx);
    const flows = await ctx.service.dailyNetFlows(agent, AS_OF);
    expect(flows).toHaveLength(14);
    expect(flows.every((row) => row.netFlowKobo === -50_000)).toBe(true);
    const balance = await ctx.ledger.balance(agent.floatAccountCode);
    expect(balance.balanceKobo).toBe(300_000);
  });

  it('rejects a malformed asOfDate with 400', async () => {
    const ctx = await makeService();
    await expect(ctx.service.run({ asOfDate: '18-01-2026' }, OPS)).rejects.toThrow('YYYY-MM-DD');
  });
});

describe('FloatForecastService — alert lifecycle (CAS)', () => {
  async function setupWithAlert() {
    const ctx = await makeService();
    await seedDepletionAgent(ctx);
    await ctx.service.run({ asOfDate: AS_OF }, OPS);
    const [alert] = await ctx.alerts.find({ status: 'open' });
    return { ctx, alert };
  }

  it('ack moves open → acknowledged exactly once; a second ack is a 409', async () => {
    const { ctx, alert } = await setupWithAlert();
    const acked = await ctx.service.acknowledgeAlert(alert.id, OPS);
    expect(acked.status).toBe('acknowledged');
    expect(acked.acknowledgedBy).toBe(OPS);
    await expect(ctx.service.acknowledgeAlert(alert.id, OPS)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('resolve works from open and from acknowledged, never twice', async () => {
    const { ctx, alert } = await setupWithAlert();
    const resolved = await ctx.service.resolveAlert(alert.id, OPS, 'run dispatched');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe(OPS);
    expect(resolved.resolution).toBe('run dispatched');
    expect(ctx.published).toContain('agent_banking.rebalance_alert.resolved');
    await expect(ctx.service.resolveAlert(alert.id, OPS)).rejects.toBeInstanceOf(ConflictException);
    await expect(ctx.service.acknowledgeAlert(alert.id, OPS)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('resolve from acknowledged succeeds (guarded CAS pins the current status)', async () => {
    const { ctx, alert } = await setupWithAlert();
    await ctx.service.acknowledgeAlert(alert.id, OPS);
    const resolved = await ctx.service.resolveAlert(alert.id, OPS);
    expect(resolved.status).toBe('resolved');
  });

  it('unknown alert ids are 404', async () => {
    const { ctx } = await setupWithAlert();
    await expect(ctx.service.acknowledgeAlert('alert-nope', OPS)).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(ctx.service.resolveAlert('alert-nope', OPS)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('after resolution the NEXT breach prediction raises a fresh alert', async () => {
    const { ctx, alert } = await setupWithAlert();
    await ctx.service.resolveAlert(alert.id, OPS);
    // Next night's run: a new open row may now exist for (agent, depletion).
    const summary = await ctx.service.run({ asOfDate: addDays(AS_OF, 1) }, OPS);
    expect(summary.alertsRaised).toBe(1);
    expect(await ctx.alerts.find({ status: 'open' })).toHaveLength(1);
  });
});

describe('FloatForecastService — rebalance runs', () => {
  it('groups unclaimed open alerts into one run; alerts cannot ride two runs', async () => {
    const ctx = await makeService();
    await seedDepletionAgent(ctx);
    await seedExcessAgent(ctx);
    await ctx.service.run({ asOfDate: AS_OF }, OPS);
    const open = await ctx.alerts.find({ status: 'open' });
    const run = await ctx.service.createRun(
      open.map((alert) => alert.id),
      OPS,
      'Kano north loop'
    );
    expect(run.status).toBe('planned');
    expect(run.alertCount).toBe(2);
    expect(run.notes).toBe('Kano north loop');
    const claimed = await ctx.alerts.find({ runId: run.id });
    expect(claimed).toHaveLength(2);
    await expect(
      ctx.service.createRun(
        open.map((alert) => alert.id),
        OPS
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await ctx.runs.find({})).toHaveLength(1);
  });

  it('rejects empty batches, unknown alerts and non-open alerts', async () => {
    const ctx = await makeService();
    await seedDepletionAgent(ctx);
    await ctx.service.run({ asOfDate: AS_OF }, OPS);
    const [alert] = await ctx.alerts.find({ status: 'open' });
    await expect(ctx.service.createRun([], OPS)).rejects.toThrow('must not be empty');
    await expect(ctx.service.createRun(['alert-nope'], OPS)).rejects.toBeInstanceOf(
      NotFoundException
    );
    await ctx.service.resolveAlert(alert.id, OPS);
    await expect(ctx.service.createRun([alert.id], OPS)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('FloatForecastService — read models', () => {
  it('lists forecasts and alerts with filters', async () => {
    const ctx = await makeService();
    await seedDepletionAgent(ctx);
    await seedThinAgent(ctx);
    await ctx.service.run({ asOfDate: AS_OF }, OPS);
    expect(await ctx.service.listForecasts({})).toHaveLength(15);
    expect(await ctx.service.listForecasts({ agentId: 'agent-deplete' })).toHaveLength(14);
    expect(await ctx.service.listAlerts({ status: 'open' })).toHaveLength(1);
    expect(await ctx.service.listAlerts({ status: 'resolved' })).toEqual([]);
    expect(await ctx.service.listRuns({})).toEqual([]);
  });
});
