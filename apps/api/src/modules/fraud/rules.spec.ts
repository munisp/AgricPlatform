import { describe, expect, it } from 'vitest';
import {
  evaluateAgentDailyVelocity,
  evaluateDormancyBurst,
  evaluateDuplicateAmountBurst,
  evaluateFloatCycleWash,
  evaluateFloatDepletion,
  evaluateStructuringBelowLimit,
  evaluateVoucherRedemptionCluster,
  percentileNearestRank,
  sentinelRuleDefinition,
  SENTINEL_RULE_CATALOG,
  validateRuleParams,
  type AgentRuleContext,
  type LedgerEntryView,
  type RuleParams,
  type SentinelEventView,
  type SentinelRuleInput
} from './rules.js';

/**
 * Known-answer fixtures for the Float Sentinel rule catalog. Every rule gets
 * at least one positive fixture and one just-below-threshold boundary
 * negative (spec §5 test plan).
 */

const AGENT: AgentRuleContext = {
  agentId: 'agent-1',
  dailyLimitKobo: 1_000_000,
  lowFloatThresholdKobo: 100_000,
  floatAccountCode: 'agent:agent-1:float'
};

let seq = 0;
function tx(
  agentId: string,
  amountKobo: number,
  occurredAt: string,
  type: 'cash_in' | 'cash_out' = 'cash_out'
): SentinelEventView {
  seq += 1;
  return {
    id: `event-tx-${seq}`,
    name: 'agentbank.transaction.posted',
    occurredAt,
    payload: { transactionId: `agtx-${seq}`, agentId, farmerId: `farmer-${seq}`, type, amountKobo }
  };
}

function redemption(
  voucherId: string,
  supplierId: string,
  farmerId: string,
  programmeId: string,
  occurredAt: string
): SentinelEventView {
  seq += 1;
  return {
    id: `event-red-${seq}`,
    name: 'inputvouchers.voucher.redeemed',
    occurredAt,
    payload: { voucherId, programmeId, farmerId, supplierId, amountKobo: 50_000 }
  };
}

function ledgerEvent(entry: LedgerEntryView, occurredAt: string): SentinelEventView {
  seq += 1;
  return {
    id: `event-led-${seq}`,
    name: 'finance.ledger.entry_posted',
    occurredAt,
    payload: { entryId: entry.entryId }
  };
}

function entry(entryId: string, accountCode: string, direction: 'debit' | 'credit', amountKobo: number): LedgerEntryView {
  return {
    entryId,
    postings: [
      { accountCode, direction, amountKobo },
      { accountCode: 'platform:cash', direction: direction === 'debit' ? 'credit' : 'debit', amountKobo }
    ]
  };
}

function input(
  events: SentinelEventView[],
  agents: AgentRuleContext[] = [AGENT],
  ledgerEntries: LedgerEntryView[] = []
): SentinelRuleInput {
  const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return {
    events: sorted,
    agents: new Map(agents.map((agent) => [agent.agentId, agent])),
    ledgerEntries: new Map(ledgerEntries.map((view) => [view.entryId, view]))
  };
}

describe('percentileNearestRank', () => {
  it('computes nearest-rank percentiles deterministically', () => {
    expect(percentileNearestRank([40, 10, 30, 20], 50)).toBe(20);
    expect(percentileNearestRank([40, 10, 30, 20], 95)).toBe(40);
    expect(percentileNearestRank([], 95)).toBeUndefined();
  });
});

describe('R1 agent_daily_velocity', () => {
  const params: RuleParams = {
    maxDailyTransactions: 3,
    baselineDays: 90,
    volumeMultiplier: 4,
    minBaselineDays: 5,
    minDailyTotalKobo: 3_000_000
  };
  // High-limit agent so the configured-limit leg (c) does not preempt the
  // statistical legs under test.
  const BIG: AgentRuleContext = {
    agentId: 'agent-big',
    dailyLimitKobo: 100_000_000,
    lowFloatThresholdKobo: 100_000,
    floatAccountCode: 'agent:agent-big:float'
  };

  it('fires on a statistical volume spike vs the agent p95 baseline', () => {
    const events: SentinelEventView[] = [];
    // Six baseline days of modest cash-out (p95 = 1,000,000 kobo).
    for (let day = 1; day <= 6; day += 1) {
      const date = `2026-08-0${day}T10:00:00.000Z`;
      events.push(tx('agent-big', 1_000_000, date));
    }
    // Spike day: two cash-outs totalling 4,500,000 > 4 × p95 and >= floor.
    events.push(tx('agent-big', 2_500_000, '2026-08-07T09:00:00.000Z'));
    const crossing = tx('agent-big', 2_000_000, '2026-08-07T11:00:00.000Z');
    events.push(crossing);
    const hits = evaluateAgentDailyVelocity(input(events, [BIG]), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleCode: 'agent_daily_velocity',
      subjectType: 'agent',
      subjectId: 'agent-big',
      firingEventId: crossing.id
    });
    expect(hits[0]!.evidence.basis).toBe('volume_vs_p95_baseline');
  });

  it('does not fire when the day total equals (not exceeds) p95 × multiplier', () => {
    const events: SentinelEventView[] = [];
    for (let day = 1; day <= 6; day += 1) {
      events.push(tx('agent-big', 1_000_000, `2026-08-0${day}T10:00:00.000Z`));
    }
    // Exactly 4 × p95 = 4,000,000 — boundary negative.
    events.push(tx('agent-big', 4_000_000, '2026-08-07T09:00:00.000Z'));
    expect(evaluateAgentDailyVelocity(input(events, [BIG]), params)).toHaveLength(0);
  });

  it('fires on the count ceiling, on the (max+1)-th event', () => {
    const events = [
      tx('agent-1', 1000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 1000, '2026-08-01T10:00:00.000Z'),
      tx('agent-1', 1000, '2026-08-01T11:00:00.000Z')
    ];
    expect(evaluateAgentDailyVelocity(input(events), params)).toHaveLength(0);
    const fourth = tx('agent-1', 1000, '2026-08-01T12:00:00.000Z');
    const hits = evaluateAgentDailyVelocity(input([...events, fourth]), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.firingEventId).toBe(fourth.id);
    expect(hits[0]!.evidence.basis).toBe('daily_count_ceiling');
  });

  it('fires on a configured daily-limit breach without any baseline', () => {
    // limit = 1,000,000 kobo; two cash-outs push the day total past it.
    const first = tx('agent-1', 700_000, '2026-08-01T09:00:00.000Z');
    const second = tx('agent-1', 400_000, '2026-08-01T10:00:00.000Z');
    const hits = evaluateAgentDailyVelocity(input([first, second]), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.firingEventId).toBe(second.id);
    expect(hits[0]!.evidence.basis).toBe('configured_daily_limit_breach');
  });

  it('stays quiet below the configured limit', () => {
    const events = [
      tx('agent-1', 600_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 399_999, '2026-08-01T10:00:00.000Z')
    ];
    expect(evaluateAgentDailyVelocity(input(events), params)).toHaveLength(0);
  });
});

describe('R2 structuring_below_limit', () => {
  const params: RuleParams = { minTransactions: 3, withinPctOfLimit: 2 };
  // Agent limit 1,000,000 kobo → qualifying band [980,000, 1,000,000).

  it('fires on >= 3 same-day transactions just below the daily limit', () => {
    const events = [
      tx('agent-1', 990_000, '2026-08-01T09:00:00.000Z', 'cash_in'),
      tx('agent-1', 980_000, '2026-08-01T10:00:00.000Z'), // lower band edge qualifies
      tx('agent-1', 999_999, '2026-08-01T11:00:00.000Z')
    ];
    const hits = evaluateStructuringBelowLimit(input(events), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleCode: 'structuring_below_limit',
      subjectId: 'agent-1',
      firingEventId: events[2]!.id
    });
    expect(hits[0]!.evidence.qualifyingCount).toBe(3);
  });

  it('does not fire with only 2 qualifying transactions (boundary negative)', () => {
    const events = [
      tx('agent-1', 990_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 990_000, '2026-08-01T10:00:00.000Z')
    ];
    expect(evaluateStructuringBelowLimit(input(events), params)).toHaveLength(0);
  });

  it('excludes amounts below the band and at/above the limit', () => {
    const events = [
      tx('agent-1', 990_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 979_999, '2026-08-01T10:00:00.000Z'), // below band
      tx('agent-1', 1_000_000, '2026-08-01T11:00:00.000Z'), // at limit — not "below"
      tx('agent-1', 985_000, '2026-08-01T12:00:00.000Z')
    ];
    expect(evaluateStructuringBelowLimit(input(events), params)).toHaveLength(0);
  });

  it('skips agents without a known configured limit (no comparison basis)', () => {
    const events = [
      tx('ghost-agent', 990_000, '2026-08-01T09:00:00.000Z'),
      tx('ghost-agent', 990_000, '2026-08-01T10:00:00.000Z'),
      tx('ghost-agent', 990_000, '2026-08-01T11:00:00.000Z')
    ];
    expect(evaluateStructuringBelowLimit(input(events), params)).toHaveLength(0);
  });
});

describe('R3 voucher_redemption_cluster', () => {
  const params: RuleParams = {
    windowMinutes: 60,
    minDistinctFarmers: 3,
    maxRedemptionsPerFarmerProgramme: 1
  };

  it('fires when one supplier redeems for 3 distinct farmers within 1h', () => {
    const events = [
      redemption('v1', 'sup-1', 'farmer-a', 'prog-1', '2026-08-01T09:00:00.000Z'),
      redemption('v2', 'sup-1', 'farmer-b', 'prog-1', '2026-08-01T09:10:00.000Z'),
      redemption('v3', 'sup-1', 'farmer-c', 'prog-1', '2026-08-01T09:20:00.000Z')
    ];
    const hits = evaluateVoucherRedemptionCluster(input(events), params);
    const supplierHits = hits.filter((hit) => hit.subjectType === 'account');
    expect(supplierHits).toHaveLength(1);
    expect(supplierHits[0]).toMatchObject({
      subjectId: 'sup-1',
      firingEventId: events[2]!.id
    });
  });

  it('does not fire when the third distinct farmer lands outside the window', () => {
    const events = [
      redemption('v1', 'sup-1', 'farmer-a', 'prog-1', '2026-08-01T09:00:00.000Z'),
      redemption('v2', 'sup-1', 'farmer-b', 'prog-1', '2026-08-01T09:10:00.000Z'),
      redemption('v3', 'sup-1', 'farmer-c', 'prog-1', '2026-08-01T10:01:00.000Z')
    ];
    expect(
      evaluateVoucherRedemptionCluster(input(events), params).filter(
        (hit) => hit.subjectType === 'account'
      )
    ).toHaveLength(0);
  });

  it('fires on same-farmer same-programme replay within the window', () => {
    const events = [
      redemption('v1', 'sup-1', 'farmer-a', 'prog-1', '2026-08-01T09:00:00.000Z'),
      redemption('v2', 'sup-2', 'farmer-a', 'prog-1', '2026-08-01T09:30:00.000Z')
    ];
    const hits = evaluateVoucherRedemptionCluster(input(events), params);
    const replayHits = hits.filter((hit) => hit.subjectType === 'voucher');
    expect(replayHits).toHaveLength(1);
    expect(replayHits[0]).toMatchObject({ subjectId: 'v2', firingEventId: events[1]!.id });
    expect(replayHits[0]!.evidence.basis).toBe('farmer_programme_replay');
  });

  it('does not fire for the same farmer redeeming in different programmes', () => {
    const events = [
      redemption('v1', 'sup-1', 'farmer-a', 'prog-1', '2026-08-01T09:00:00.000Z'),
      redemption('v2', 'sup-1', 'farmer-a', 'prog-2', '2026-08-01T09:30:00.000Z')
    ];
    expect(evaluateVoucherRedemptionCluster(input(events), params)).toHaveLength(0);
  });
});

describe('R4 float_cycle_wash', () => {
  const params: RuleParams = {
    windowHours: 24,
    maxNetRatioPct: 1,
    minGrossKobo: 1_000,
    minTransactions: 4
  };

  it('fires when deposits and withdrawals net to ~0 at material gross', () => {
    const events = [
      tx('agent-1', 300, '2026-08-01T09:00:00.000Z', 'cash_in'),
      tx('agent-1', 300, '2026-08-01T10:00:00.000Z', 'cash_out'),
      tx('agent-1', 300, '2026-08-01T11:00:00.000Z', 'cash_in'),
      tx('agent-1', 300, '2026-08-01T12:00:00.000Z', 'cash_out')
    ];
    const hits = evaluateFloatCycleWash(input(events), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleCode: 'float_cycle_wash',
      firingEventId: events[3]!.id
    });
    expect(hits[0]!.evidence.netKobo).toBe(0);
  });

  it('does not fire when gross is below the floor (boundary negative)', () => {
    const small = { ...params, minGrossKobo: 10_000 };
    const events = [
      tx('agent-1', 300, '2026-08-01T09:00:00.000Z', 'cash_in'),
      tx('agent-1', 300, '2026-08-01T10:00:00.000Z', 'cash_out'),
      tx('agent-1', 300, '2026-08-01T11:00:00.000Z', 'cash_in'),
      tx('agent-1', 300, '2026-08-01T12:00:00.000Z', 'cash_out')
    ];
    expect(evaluateFloatCycleWash(input(events), small)).toHaveLength(0);
  });

  it('does not fire when the net ratio exceeds the tolerance', () => {
    const events = [
      tx('agent-1', 300, '2026-08-01T09:00:00.000Z', 'cash_in'),
      tx('agent-1', 300, '2026-08-01T10:00:00.000Z', 'cash_out'),
      tx('agent-1', 300, '2026-08-01T11:00:00.000Z', 'cash_in'),
      tx('agent-1', 100, '2026-08-01T12:00:00.000Z', 'cash_out')
      // gross 1000, net 200 → 200*100 > 1000*1 → not a wash
    ];
    expect(evaluateFloatCycleWash(input(events), params)).toHaveLength(0);
  });
});

describe('R5 dormancy_burst', () => {
  const params: RuleParams = { dormantDays: 30, minBurstKobo: 2_000_000, burstMultiplier: 3 };

  it('fires when a dormant agent bursts above its own p99 × multiplier', () => {
    const events = [
      tx('agent-1', 1_000_000, '2026-06-01T09:00:00.000Z'),
      tx('agent-1', 1_000_000, '2026-06-02T09:00:00.000Z'),
      tx('agent-1', 1_000_000, '2026-06-03T09:00:00.000Z'),
      // 45 days later, 3,000,001 > p99(1e6) × 3 = 3,000,000 and >= floor.
      tx('agent-1', 3_000_001, '2026-07-18T09:00:00.000Z')
    ];
    const hits = evaluateDormancyBurst(input(events), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.firingEventId).toBe(events[3]!.id);
  });

  it('does not fire when the amount equals (not exceeds) the statistical threshold', () => {
    const events = [
      tx('agent-1', 1_000_000, '2026-06-01T09:00:00.000Z'),
      tx('agent-1', 3_000_000, '2026-07-18T09:00:00.000Z')
    ];
    expect(evaluateDormancyBurst(input(events), params)).toHaveLength(0);
  });

  it('does not fire when the dormancy gap is shorter than the threshold', () => {
    const events = [
      tx('agent-1', 1_000_000, '2026-07-01T09:00:00.000Z'),
      tx('agent-1', 5_000_000, '2026-07-25T09:00:00.000Z') // 24 days < 30
    ];
    expect(evaluateDormancyBurst(input(events), params)).toHaveLength(0);
  });

  it('fires for a first transaction long after registration when above the floor', () => {
    const registration: SentinelEventView = {
      id: 'event-reg-1',
      name: 'agentbank.agent.registered',
      occurredAt: '2026-05-01T09:00:00.000Z',
      payload: { agentId: 'agent-1', userId: 'user-1' }
    };
    const burst = tx('agent-1', 250_000_000, '2026-06-15T09:00:00.000Z'); // 45 days later
    const hits = evaluateDormancyBurst(input([registration, burst]), {
      ...params,
      minBurstKobo: 200_000_000
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.firingEventId).toBe(burst.id);
  });

  it('stays quiet without registration or prior activity (ambiguous basis)', () => {
    const burst = tx('agent-1', 250_000_000, '2026-06-15T09:00:00.000Z');
    expect(
      evaluateDormancyBurst(input([burst]), { ...params, minBurstKobo: 200_000_000 })
    ).toHaveLength(0);
  });
});

describe('R6 float_depletion', () => {
  it('fires when the stream-computed float balance crosses the threshold downward', () => {
    const topUp = entry('entry-1', 'agent:agent-1:float', 'debit', 500_000);
    const drawdown = entry('entry-2', 'agent:agent-1:float', 'credit', 450_000);
    const events = [
      ledgerEvent(topUp, '2026-08-01T09:00:00.000Z'),
      ledgerEvent(drawdown, '2026-08-01T10:00:00.000Z')
    ];
    const hits = evaluateFloatDepletion(input(events, [AGENT], [topUp, drawdown]));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleCode: 'float_depletion',
      subjectId: 'agent-1',
      firingEventId: events[1]!.id,
      severity: 'low'
    });
    expect(hits[0]!.evidence.balanceAfterKobo).toBe(50_000);
  });

  it('does not fire when the balance stays above the threshold', () => {
    const topUp = entry('entry-1', 'agent:agent-1:float', 'debit', 500_000);
    const drawdown = entry('entry-2', 'agent:agent-1:float', 'credit', 300_000);
    const events = [
      ledgerEvent(topUp, '2026-08-01T09:00:00.000Z'),
      ledgerEvent(drawdown, '2026-08-01T10:00:00.000Z')
    ];
    expect(evaluateFloatDepletion(input(events, [AGENT], [topUp, drawdown]))).toHaveLength(0);
  });

  it('does not fire when the balance was never SEEN above the threshold (mid-stream catch-up fails quiet)', () => {
    const drawdown = entry('entry-1', 'agent:agent-1:float', 'credit', 50_000);
    const events = [ledgerEvent(drawdown, '2026-08-01T09:00:00.000Z')];
    expect(evaluateFloatDepletion(input(events, [AGENT], [drawdown]))).toHaveLength(0);
  });

  it('skips unresolved ledger entries (projector-style rebuild tolerance)', () => {
    const ghost = ledgerEvent(entry('entry-9', 'agent:agent-1:float', 'credit', 50_000), '2026-08-01T09:00:00.000Z');
    expect(evaluateFloatDepletion(input([ghost], [AGENT], []))).toHaveLength(0);
  });
});

describe('R7 duplicate_amount_burst', () => {
  const params: RuleParams = { windowMinutes: 30, minCount: 3 };

  it('fires on the third identical-amount transaction within the window', () => {
    const events = [
      tx('agent-1', 50_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 50_000, '2026-08-01T09:10:00.000Z'),
      tx('agent-1', 50_000, '2026-08-01T09:20:00.000Z')
    ];
    const hits = evaluateDuplicateAmountBurst(input(events), params);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.firingEventId).toBe(events[2]!.id);
    expect(hits[0]!.evidence.amountKobo).toBe(50_000);
  });

  it('does not fire with only two identical amounts (boundary negative)', () => {
    const events = [
      tx('agent-1', 50_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 50_000, '2026-08-01T09:10:00.000Z')
    ];
    expect(evaluateDuplicateAmountBurst(input(events), params)).toHaveLength(0);
  });

  it('does not fire when the third event lands outside the window', () => {
    const events = [
      tx('agent-1', 50_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 50_000, '2026-08-01T09:20:00.000Z'),
      tx('agent-1', 50_000, '2026-08-01T09:41:00.000Z')
    ];
    expect(evaluateDuplicateAmountBurst(input(events), params)).toHaveLength(0);
  });

  it('groups by exact amount — mixed amounts never combine', () => {
    const events = [
      tx('agent-1', 50_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 50_001, '2026-08-01T09:10:00.000Z'),
      tx('agent-1', 50_000, '2026-08-01T09:20:00.000Z')
    ];
    expect(evaluateDuplicateAmountBurst(input(events), params)).toHaveLength(0);
  });
});

describe('rule catalog + param validation', () => {
  it('catalog exposes all seven rules with evaluators', () => {
    expect(SENTINEL_RULE_CATALOG.map((definition) => definition.code).sort()).toEqual([
      'agent_daily_velocity',
      'dormancy_burst',
      'duplicate_amount_burst',
      'float_cycle_wash',
      'float_depletion',
      'structuring_below_limit',
      'voucher_redemption_cluster'
    ]);
    for (const definition of SENTINEL_RULE_CATALOG) {
      expect(sentinelRuleDefinition(definition.code)).toBe(definition);
    }
  });

  it('every rule is pure: same input twice yields identical hits', () => {
    const events = [
      tx('agent-1', 990_000, '2026-08-01T09:00:00.000Z'),
      tx('agent-1', 990_000, '2026-08-01T10:00:00.000Z'),
      tx('agent-1', 990_000, '2026-08-01T11:00:00.000Z')
    ];
    const fixture = input(events);
    for (const definition of SENTINEL_RULE_CATALOG) {
      expect(definition.evaluate(fixture, definition.defaults)).toEqual(
        definition.evaluate(fixture, definition.defaults)
      );
    }
  });

  it('rejects unknown codes, unknown params and non-number values', () => {
    expect(() => validateRuleParams('nope', {})).toThrow(/Unknown fraud rule code/);
    expect(() => validateRuleParams('float_depletion', { anything: 1 })).toThrow(/Unknown param/);
    expect(() =>
      validateRuleParams('duplicate_amount_burst', { minCount: 'three' })
    ).toThrow(/must be a finite number/);
    expect(validateRuleParams('duplicate_amount_burst', { minCount: 4 })).toEqual({ minCount: 4 });
  });
});
