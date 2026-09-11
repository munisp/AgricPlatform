import { ConflictException } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { createInMemoryAgentBankingAgentRepository } from '../../database/repositories/agent-banking.repository.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import {
  createInMemoryFraudSentinelRepository,
  type FraudAlertRecord,
  type FraudSentinelRepository,
  type InMemoryFraudSentinelRepository
} from '../../database/repositories/fraud.repository.js';
import { createInMemoryLedgerEntryRepository } from '../../database/repositories/ledger.repository.js';
import { InMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { SENTINEL_RULE_CATALOG } from './rules.js';
import {
  FLOAT_SENTINEL_FLAG,
  FRAUD_SENTINEL_CONSUMER,
  FraudSentinelService
} from './sentinel.service.js';

/**
 * Projector/consumer contract tests for the Float Sentinel service (spec §5
 * test plan): replay tolerance (re-delivered events never double-alert),
 * mark-after idempotency, flag-off no-op, fail-closed rule errors, and the
 * admin case-queue lifecycle.
 */

const AGENT_ID = 'agent-1';
const AGENT_LIMIT_KOBO = 1_000_000;

function seedAgents() {
  const agents = createInMemoryAgentBankingAgentRepository();
  return agents
    .create({
      id: AGENT_ID,
      userId: 'user-agent-1',
      organisation: 'Test Cooperative',
      status: 'ACTIVE',
      floatAccountCode: 'agent:agent-1:float',
      commissionAccountCode: 'agent:agent-1:commission_payable',
      dailyLimitKobo: AGENT_LIMIT_KOBO,
      lowFloatThresholdKobo: 100_000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    .then(() => agents);
}

async function seedRules(fraud: InMemoryFraudSentinelRepository): Promise<void> {
  for (const definition of SENTINEL_RULE_CATALOG) {
    await fraud.insertRuleVersion({
      code: definition.code,
      version: 1,
      description: `${definition.code} v1`,
      params: definition.defaults,
      enabled: true,
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
  }
}

interface Harness {
  sentinel: FraudSentinelService;
  outbox: InMemoryOutboxRepository;
  dedup: EventDedupService;
  fraud: InMemoryFraudSentinelRepository;
  events: DomainEventsService;
  flags: FeatureFlagsService;
  audit: AuditService;
}

async function harness(): Promise<Harness> {
  const outbox = new InMemoryOutboxRepository();
  const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
  const fraud = createInMemoryFraudSentinelRepository();
  const ledgerEntries = createInMemoryLedgerEntryRepository();
  const events = new DomainEventsService(outbox);
  const flags = new FeatureFlagsService(createInMemoryFeatureFlagRepository());
  const audit = new AuditService(createInMemoryAuditRepository());
  const agents = await seedAgents();
  const sentinel = new FraudSentinelService(
    outbox,
    dedup,
    fraud,
    agents,
    ledgerEntries,
    events,
    flags,
    new TelemetryService(),
    audit
  );
  await seedRules(fraud);
  return { sentinel, outbox, dedup, fraud, events, flags, audit };
}

async function enableFlag(flags: FeatureFlagsService): Promise<void> {
  await flags.upsert({
    key: FLOAT_SENTINEL_FLAG,
    enabled: true,
    roleAllowlist: [],
    percentage: 100,
    description: 'test enablement'
  });
}

/** Three same-day transactions within 2% below the agent's daily limit → R2 fires. */
async function publishStructuringFixture(events: DomainEventsService): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const event = await events.publish('agentbank.transaction.posted', {
      transactionId: `agtx-${index}`,
      agentId: AGENT_ID,
      farmerId: `farmer-${index}`,
      type: 'cash_out',
      amountKobo: 990_000
    });
    ids.push(event.id);
  }
  return ids;
}

describe('FraudSentinelService', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('is a no-op when the rollout flag is off (nothing evaluated, nothing marked)', async () => {
    const eventIds = await publishStructuringFixture(h.events);
    const result = await h.sentinel.run();
    expect(result.ran).toBe(false);
    expect(result.reason).toContain(FLOAT_SENTINEL_FLAG);
    expect(await h.fraud.findAlerts({})).toHaveLength(0);
    for (const id of eventIds) {
      expect(await h.dedup.has(FRAUD_SENTINEL_CONSUMER, id)).toBe(false);
    }
  });

  it('raises idempotent dedup-keyed alerts and publishes fraud.alert.raised', async () => {
    await enableFlag(h.flags);
    const eventIds = await publishStructuringFixture(h.events);
    const result = await h.sentinel.run();
    expect(result.ran).toBe(true);
    // The fixture realistically fires THREE rules: R2 structuring (amounts in
    // the just-below band), R1 configured-limit breach (day total 2.97M >
    // the 1M limit) and R7 duplicate-amount burst (3 identical amounts).
    expect(result.alertsCreated).toBe(3);
    expect(result.markedProcessed).toBe(eventIds.length);

    const alerts = await h.fraud.findAlerts({});
    expect(alerts.map((row) => row.ruleCode).sort()).toEqual([
      'agent_daily_velocity',
      'duplicate_amount_burst',
      'structuring_below_limit'
    ]);
    const alert = alerts.find((row) => row.ruleCode === 'structuring_below_limit')!;
    expect(alert).toMatchObject({
      ruleCode: 'structuring_below_limit',
      ruleVersion: 1,
      subjectType: 'agent',
      subjectId: AGENT_ID,
      severity: 'high',
      status: 'open'
    });
    // Dedup key derives from rule id + firing event id (+ subject).
    expect(alert.dedupKey).toBe(
      `structuring_below_limit:1:${eventIds[2]}:agent:${AGENT_ID}`
    );
    // Evidence is reviewer-reproducible: contributing event ids + values.
    expect(alert.evidence.eventIds).toEqual(eventIds);

    const raised = (await h.outbox.list()).filter((event) => event.name === 'fraud.alert.raised');
    expect(raised).toHaveLength(3);
    expect(raised.map((event) => (event.payload as { alertId: string }).alertId).sort()).toEqual(
      alerts.map((row) => row.id).sort()
    );
  });

  it('replay never double-alerts: re-delivered events re-compute identical hits, suppressed by dedup key', async () => {
    await enableFlag(h.flags);
    await publishStructuringFixture(h.events);
    await h.sentinel.run();
    const second = await h.sentinel.run();
    expect(second.alertsCreated).toBe(0);
    expect(second.alertsSuppressed).toBe(3);
    expect(second.markedProcessed).toBe(0);
    expect(await h.fraud.findAlerts({})).toHaveLength(3);
    // Raised events fired exactly once each across both passes.
    expect(
      (await h.outbox.list()).filter((event) => event.name === 'fraud.alert.raised')
    ).toHaveLength(3);
  });

  it('mark-after: a failing alert upsert leaves events unprocessed and the retry converges', async () => {
    await enableFlag(h.flags);
    const eventIds = await publishStructuringFixture(h.events);
    // Sabotage the first upsert only.
    const original = h.fraud.upsertAlert.bind(h.fraud);
    let armed = true;
    h.fraud.upsertAlert = async (
      alert: Parameters<FraudSentinelRepository['upsertAlert']>[0]
    ): Promise<{ alert: FraudAlertRecord; created: boolean }> => {
      if (armed) {
        armed = false;
        throw new Error('simulated write failure');
      }
      return original(alert);
    };
    await expect(h.sentinel.run()).rejects.toThrow('simulated write failure');
    // Mark-after: nothing was recorded as processed, so the next pass retries.
    for (const id of eventIds) {
      expect(await h.dedup.has(FRAUD_SENTINEL_CONSUMER, id)).toBe(false);
    }
    const retry = await h.sentinel.run();
    expect(retry.alertsCreated).toBe(3);
    expect(await h.fraud.findAlerts({})).toHaveLength(3);
  });

  it('fail-closed: a rule row without an evaluator is disabled and counted; other rules still run', async () => {
    await h.fraud.insertRuleVersion({
      code: 'no_such_evaluator',
      version: 1,
      description: 'misconfigured rule row',
      params: {},
      enabled: true,
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    await enableFlag(h.flags);
    await publishStructuringFixture(h.events);
    const result = await h.sentinel.run();
    expect(result.ruleErrors).toBe(1);
    expect(result.alertsCreated).toBe(3); // the healthy rules still fired
    const broken = await h.fraud.currentRule('no_such_evaluator');
    expect(broken?.enabled).toBe(false);
  });

  it('individually disabled rules do not evaluate', async () => {
    await enableFlag(h.flags);
    await h.sentinel.setRuleEnabled('structuring_below_limit', false, 'admin-1');
    await publishStructuringFixture(h.events);
    await h.sentinel.run();
    const alerts = await h.fraud.findAlerts({});
    expect(alerts.some((row) => row.ruleCode === 'structuring_below_limit')).toBe(false);
    // The other two fixture-matching rules still fired.
    expect(alerts.map((row) => row.ruleCode).sort()).toEqual([
      'agent_daily_velocity',
      'duplicate_amount_burst'
    ]);
  });

  it('confirm/dismiss are guarded CAS transitions, audited and evented', async () => {
    await enableFlag(h.flags);
    await publishStructuringFixture(h.events);
    await h.sentinel.run();
    const alert = (await h.fraud.findAlerts({}))[0]!;

    const confirmed = await h.sentinel.confirmAlert(alert.id, 'officer-1', 'verified with agent');
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.resolvedBy).toBe('officer-1');
    // Second resolution loses the CAS race.
    await expect(h.sentinel.confirmAlert(alert.id, 'officer-2')).rejects.toBeInstanceOf(
      ConflictException
    );
    await expect(h.sentinel.dismissAlert(alert.id, 'officer-2', 'duplicate')).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(
      (await h.outbox.list()).filter((event) => event.name === 'fraud.alert.confirmed')
    ).toHaveLength(1);
    expect(
      (await h.audit.list()).filter((entry) => entry.action === 'fraud.alert.confirmed')
    ).toHaveLength(1);

    await expect(h.sentinel.dismissAlert('missing', 'officer-1', 'x')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(h.sentinel.dismissAlert(alert.id, 'officer-1', ' ')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('rule param updates create a new immutable version and never touch the old one', async () => {
    const before = await h.fraud.currentRule('structuring_below_limit');
    expect(before?.version).toBe(1);
    const next = await h.sentinel.updateRuleParams(
      'structuring_below_limit',
      { minTransactions: 5 },
      'admin-1'
    );
    expect(next.version).toBe(2);
    // Unspecified keys carry over from the current version.
    expect(next.params).toEqual({ minTransactions: 5, withinPctOfLimit: 2 });
    const v1 = (await h.fraud.listRules()).find(
      (rule) => rule.code === 'structuring_below_limit' && rule.version === 1
    );
    expect(v1?.params).toEqual({ minTransactions: 3, withinPctOfLimit: 2 });
    // Immutability: inserting the same (code, version) again conflicts.
    await expect(
      h.fraud.insertRuleVersion({ ...v1!, params: { minTransactions: 9 } })
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      h.sentinel.updateRuleParams('structuring_below_limit', { bogus: 1 }, 'admin-1')
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.sentinel.updateRuleParams('no_such_rule', {}, 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(
      (await h.audit.list()).filter((entry) => entry.action === 'fraud.rule.params_updated')
    ).toHaveLength(1);
  });

  it('lists rules with per-rule hit counts', async () => {
    await enableFlag(h.flags);
    await publishStructuringFixture(h.events);
    await h.sentinel.run();
    const rules = await h.sentinel.listRules();
    const structuring = rules.find((rule) => rule.code === 'structuring_below_limit');
    expect(structuring?.hitCount).toBe(1);
    expect(rules.find((rule) => rule.code === 'float_depletion')?.hitCount).toBe(0);
  });

  it('case lifecycle: create from alerts, guarded resolve, evented', async () => {
    await enableFlag(h.flags);
    await publishStructuringFixture(h.events);
    await h.sentinel.run();
    const alert = (await h.fraud.findAlerts({}))[0]!;

    await expect(h.sentinel.createCase(['missing-alert'], undefined, 'officer-1')).rejects.toBeInstanceOf(
      NotFoundException
    );
    const created = await h.sentinel.createCase([alert.id], 'officer-1', 'admin-1');
    expect(created.status).toBe('open');
    expect(created.alertIds).toEqual([alert.id]);

    const resolved = await h.sentinel.resolveCase(created.id, 'agent suspended pending review', 'officer-1');
    expect(resolved.status).toBe('resolved');
    await expect(
      h.sentinel.resolveCase(created.id, 'again', 'officer-2')
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await h.outbox.list()).filter((event) => event.name === 'fraud.case.resolved')
    ).toHaveLength(1);
    expect(
      (await h.audit.list()).filter((entry) => entry.action === 'fraud.case.resolved')
    ).toHaveLength(1);
    await expect(h.sentinel.resolveCase(created.id, ' ', 'officer-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});
