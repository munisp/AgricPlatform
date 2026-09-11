import { lagosDateKey } from '../analytics/retention.js';

/**
 * Float Sentinel — deterministic fraud/liquidity anomaly rules (Stage 27).
 *
 * Every rule in this file is a PURE function of an ordered event window plus
 * static context (the agent directory and the referenced ledger entries).
 * No ML, no external calls, no clock reads: the same input always yields the
 * same hits, which is what makes replay (outbox catch-up, dedup-ledger gaps)
 * converge to identical alert rows via the dedup-key upsert in the service.
 *
 * The engine is a DETECTIVE control: hits become admin-queue alerts; the
 * sentinel never blocks, delays, or alters money movement itself.
 *
 * Rule catalog (codes are the fraud.rules PK; thresholds seeded by migration
 * 059 and tunable per code via versioned params):
 *   R1 agent_daily_velocity        — same-day volume/count vs own 90-day p95,
 *                                    and hard breach of the configured daily limit
 *   R2 structuring_below_limit     — >=N same-day tx within X% below the daily limit
 *   R3 voucher_redemption_cluster  — supplier-side farmer spread in 1h, or
 *                                    same-farmer same-programme replay in 1h
 *   R4 float_cycle_wash            — deposits/withdrawals net ~0 over 24h at volume
 *   R5 dormancy_burst              — >=30d inactive then a burst-sized transaction
 *   R6 float_depletion             — stream-computed float balance crosses the
 *                                    agent's low-float threshold from above
 *   R7 duplicate_amount_burst      — >=N identical-amount tx in a short window
 */

// ---------------------------------------------------------------------------
// Shared views (pure inputs — the service builds these from the outbox +
// repositories; tests build them from fixtures).
// ---------------------------------------------------------------------------

/** Minimal event view the rules read (name/payload/occurredAt + stable id). */
export interface SentinelEventView {
  id: string;
  name: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Static agent attributes the rules compare against (from agent_banking.agents). */
export interface AgentRuleContext {
  agentId: string;
  dailyLimitKobo: number;
  lowFloatThresholdKobo: number;
  /** Ledger sub-account backing the float (agent:<id>:float). */
  floatAccountCode: string;
}

export interface PostingView {
  accountCode: string;
  direction: 'debit' | 'credit';
  amountKobo: number;
}

/** Ledger journal entry view keyed by entry id (postings only — rules need no more). */
export interface LedgerEntryView {
  entryId: string;
  postings: PostingView[];
}

export interface SentinelRuleInput {
  /** Sentinel-relevant events, ascending occurred_at (outbox order). */
  events: SentinelEventView[];
  /** agentId → static rule context for every known agent. */
  agents: ReadonlyMap<string, AgentRuleContext>;
  /** entryId → postings for every finance.ledger.entry_posted in the window. */
  ledgerEntries: ReadonlyMap<string, LedgerEntryView>;
}

export type FraudSeverity = 'low' | 'medium' | 'high';
export type FraudSubjectType = 'agent' | 'voucher' | 'account';

/** One rule firing. `firingEventId` + rule code/version + subject form the alert dedup key. */
export interface RuleHit {
  ruleCode: string;
  severity: FraudSeverity;
  subjectType: FraudSubjectType;
  subjectId: string;
  /** The event whose arrival completes the pattern (stable across replays). */
  firingEventId: string;
  /** Contributing event ids + computed values (reviewer-reproducible basis). */
  evidence: Record<string, unknown>;
}

export type RuleParams = Record<string, unknown>;
export type SentinelRuleEvaluator = (input: SentinelRuleInput, params: RuleParams) => RuleHit[];

// ---------------------------------------------------------------------------
// Event payload views (narrowed defensively — a malformed payload makes the
// event ineligible for the rule, never a thrown rule evaluation).
// ---------------------------------------------------------------------------

interface AgentTxView {
  eventId: string;
  occurredAt: string;
  agentId: string;
  farmerId?: string;
  type: 'cash_in' | 'cash_out' | 'voucher_redemption';
  amountKobo: number;
}

function asAgentTx(event: SentinelEventView): AgentTxView | undefined {
  if (event.name !== 'agentbank.transaction.posted') {
    return undefined;
  }
  const payload = event.payload;
  const agentId = payload.agentId;
  const type = payload.type;
  const amountKobo = payload.amountKobo;
  if (
    typeof agentId !== 'string' ||
    (type !== 'cash_in' && type !== 'cash_out' && type !== 'voucher_redemption') ||
    typeof amountKobo !== 'number' ||
    !Number.isSafeInteger(amountKobo) ||
    amountKobo <= 0
  ) {
    return undefined;
  }
  return {
    eventId: event.id,
    occurredAt: event.occurredAt,
    agentId,
    ...(typeof payload.farmerId === 'string' ? { farmerId: payload.farmerId } : {}),
    type,
    amountKobo
  };
}

interface VoucherRedemptionView {
  eventId: string;
  occurredAt: string;
  voucherId: string;
  programmeId?: string;
  farmerId?: string;
  supplierId?: string;
  amountKobo?: number;
}

function asVoucherRedemption(event: SentinelEventView): VoucherRedemptionView | undefined {
  if (event.name !== 'inputvouchers.voucher.redeemed') {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload.voucherId !== 'string') {
    return undefined;
  }
  return {
    eventId: event.id,
    occurredAt: event.occurredAt,
    voucherId: payload.voucherId,
    ...(typeof payload.programmeId === 'string' ? { programmeId: payload.programmeId } : {}),
    ...(typeof payload.farmerId === 'string' ? { farmerId: payload.farmerId } : {}),
    ...(typeof payload.supplierId === 'string' ? { supplierId: payload.supplierId } : {}),
    ...(typeof payload.amountKobo === 'number' ? { amountKobo: payload.amountKobo } : {})
  };
}

/** agentId → its agentbank.transaction.posted events, in stream order. */
function agentTransactions(input: SentinelRuleInput): Map<string, AgentTxView[]> {
  const perAgent = new Map<string, AgentTxView[]>();
  for (const event of input.events) {
    const tx = asAgentTx(event);
    if (!tx) {
      continue;
    }
    const list = perAgent.get(tx.agentId) ?? [];
    list.push(tx);
    perAgent.set(tx.agentId, list);
  }
  return perAgent;
}

/** Nearest-rank percentile over integer kobo values (deterministic). */
export function percentileNearestRank(values: readonly number[], pct: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((pct / 100) * sorted.length));
  return sorted[rank - 1];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function numParam(params: RuleParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// R1 — agent_daily_velocity
// ---------------------------------------------------------------------------

export interface AgentDailyVelocityParams {
  /** Absolute per-day transaction count ceiling (ops norm, not the money limit). */
  maxDailyTransactions: number;
  /** Trailing window (days) over which the agent's own daily totals baseline is built. */
  baselineDays: number;
  /** Alert when a day's cash-out total exceeds p95(baseline daily totals) × this. */
  volumeMultiplier: number;
  /** Minimum active baseline days before the p95 leg may fire (cold-start guard). */
  minBaselineDays: number;
  /** Absolute floor for the p95 leg (kobo) — small agents never stat-alert. */
  minDailyTotalKobo: number;
}

export const AGENT_DAILY_VELOCITY_DEFAULTS: AgentDailyVelocityParams = {
  maxDailyTransactions: 40,
  baselineDays: 90,
  volumeMultiplier: 4,
  minBaselineDays: 5,
  minDailyTotalKobo: 500_000_000 // ₦5,000,000
};

/**
 * R1: per agent per Lagos day, fire when
 *   (a) the day's transaction count exceeds maxDailyTransactions, or
 *   (b) the day's cash-out total exceeds BOTH the agent's trailing-baseline
 *       p95 × volumeMultiplier AND minDailyTotalKobo (with enough baseline
 *       days to make the percentile meaningful), or
 *   (c) the day's total exceeds the agent's CONFIGURED daily limit — the
 *       service enforces that limit synchronously, so a breach in the stream
 *       is a limit-bypass race/bug and always alertable (no baseline needed).
 * The firing event is the FIRST event of the day that crosses the threshold,
 * so growing the day later cannot re-fire the rule (one alert per agent/day).
 */
export function evaluateAgentDailyVelocity(
  input: SentinelRuleInput,
  params: RuleParams
): RuleHit[] {
  const p: AgentDailyVelocityParams = {
    maxDailyTransactions: numParam(params, 'maxDailyTransactions', AGENT_DAILY_VELOCITY_DEFAULTS.maxDailyTransactions),
    baselineDays: numParam(params, 'baselineDays', AGENT_DAILY_VELOCITY_DEFAULTS.baselineDays),
    volumeMultiplier: numParam(params, 'volumeMultiplier', AGENT_DAILY_VELOCITY_DEFAULTS.volumeMultiplier),
    minBaselineDays: numParam(params, 'minBaselineDays', AGENT_DAILY_VELOCITY_DEFAULTS.minBaselineDays),
    minDailyTotalKobo: numParam(params, 'minDailyTotalKobo', AGENT_DAILY_VELOCITY_DEFAULTS.minDailyTotalKobo)
  };
  const hits: RuleHit[] = [];
  for (const [agentId, txs] of agentTransactions(input)) {
    const agent = input.agents.get(agentId);
    interface DayAgg {
      count: number;
      cashInKobo: number;
      cashOutKobo: number;
      totalKobo: number;
      events: AgentTxView[];
    }
    const days = new Map<string, DayAgg>();
    for (const tx of txs) {
      const key = lagosDateKey(new Date(tx.occurredAt));
      const day = days.get(key) ?? { count: 0, cashInKobo: 0, cashOutKobo: 0, totalKobo: 0, events: [] };
      day.count += 1;
      day.totalKobo += tx.amountKobo;
      if (tx.type === 'cash_in') {
        day.cashInKobo += tx.amountKobo;
      }
      if (tx.type === 'cash_out') {
        day.cashOutKobo += tx.amountKobo;
      }
      day.events.push(tx);
      days.set(key, day);
    }
    const dayKeys = [...days.keys()].sort();
    for (const dayKey of dayKeys) {
      const day = days.get(dayKey)!;
      const firstTs = new Date(day.events[0]!.occurredAt).getTime();

      // (a) count ceiling — firing event = the (maxDailyTransactions+1)-th tx.
      if (day.count > p.maxDailyTransactions) {
        const firing = day.events[p.maxDailyTransactions]!;
        hits.push({
          ruleCode: 'agent_daily_velocity',
          severity: 'high',
          subjectType: 'agent',
          subjectId: agentId,
          firingEventId: firing.eventId,
          evidence: {
            basis: 'daily_count_ceiling',
            lagosDate: dayKey,
            count: day.count,
            maxDailyTransactions: p.maxDailyTransactions,
            eventIds: day.events.map((tx) => tx.eventId)
          }
        });
        continue; // one alert per agent/day per rule
      }

      // (c) configured-limit breach — firing event = the tx that first
      // pushes the cumulative day total over the configured daily limit.
      if (agent && day.totalKobo > agent.dailyLimitKobo) {
        let cumulative = 0;
        const firing = day.events.find((tx) => {
          cumulative += tx.amountKobo;
          return cumulative > agent.dailyLimitKobo;
        })!;
        hits.push({
          ruleCode: 'agent_daily_velocity',
          severity: 'high',
          subjectType: 'agent',
          subjectId: agentId,
          firingEventId: firing.eventId,
          evidence: {
            basis: 'configured_daily_limit_breach',
            lagosDate: dayKey,
            totalKobo: day.totalKobo,
            dailyLimitKobo: agent.dailyLimitKobo,
            eventIds: day.events.map((tx) => tx.eventId)
          }
        });
        continue;
      }

      // (b) statistical volume spike vs own trailing baseline.
      const baselineTotals = dayKeys
        .filter((key) => {
          if (key >= dayKey) {
            return false;
          }
          const otherFirst = days.get(key)!.events[0]!.occurredAt;
          return firstTs - new Date(otherFirst).getTime() <= p.baselineDays * DAY_MS;
        })
        .map((key) => days.get(key)!.cashOutKobo);
      if (
        baselineTotals.length >= p.minBaselineDays &&
        day.cashOutKobo >= p.minDailyTotalKobo
      ) {
        const p95 = percentileNearestRank(baselineTotals, 95)!;
        if (p95 > 0 && day.cashOutKobo > p95 * p.volumeMultiplier) {
          let cumulative = 0;
          const threshold = p95 * p.volumeMultiplier;
          const firing =
            day.events
              .filter((tx) => tx.type === 'cash_out')
              .find((tx) => {
                cumulative += tx.amountKobo;
                return cumulative > threshold;
              }) ?? day.events[day.events.length - 1]!;
          hits.push({
            ruleCode: 'agent_daily_velocity',
            severity: 'high',
            subjectType: 'agent',
            subjectId: agentId,
            firingEventId: firing.eventId,
            evidence: {
              basis: 'volume_vs_p95_baseline',
              lagosDate: dayKey,
              cashOutKobo: day.cashOutKobo,
              baselineP95Kobo: p95,
              volumeMultiplier: p.volumeMultiplier,
              baselineDays: baselineTotals.length,
              eventIds: day.events.map((tx) => tx.eventId)
            }
          });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// R2 — structuring_below_limit
// ---------------------------------------------------------------------------

export interface StructuringParams {
  /** Minimum qualifying same-day transactions before the pattern fires. */
  minTransactions: number;
  /** A transaction qualifies when its amount is within this % BELOW the limit. */
  withinPctOfLimit: number;
}

export const STRUCTURING_DEFAULTS: StructuringParams = {
  minTransactions: 3,
  withinPctOfLimit: 2
};

/**
 * R2: per agent per Lagos day, fire when >= minTransactions transactions each
 * land in [limit × (100 − pct)/100, limit) — repeated just-below-the-limit
 * amounts are the classic structuring signature against a daily cap. Fires
 * once per agent/day, on the minTransactions-th qualifying event. Agents
 * without a known configured limit are skipped (no basis to compare).
 */
export function evaluateStructuringBelowLimit(
  input: SentinelRuleInput,
  params: RuleParams
): RuleHit[] {
  const p: StructuringParams = {
    minTransactions: numParam(params, 'minTransactions', STRUCTURING_DEFAULTS.minTransactions),
    withinPctOfLimit: numParam(params, 'withinPctOfLimit', STRUCTURING_DEFAULTS.withinPctOfLimit)
  };
  const hits: RuleHit[] = [];
  for (const [agentId, txs] of agentTransactions(input)) {
    const agent = input.agents.get(agentId);
    if (!agent || agent.dailyLimitKobo <= 0) {
      continue;
    }
    const days = new Map<string, AgentTxView[]>();
    for (const tx of txs) {
      const qualifies =
        tx.amountKobo < agent.dailyLimitKobo &&
        tx.amountKobo * 100 >= agent.dailyLimitKobo * (100 - p.withinPctOfLimit);
      if (!qualifies) {
        continue;
      }
      const key = lagosDateKey(new Date(tx.occurredAt));
      const list = days.get(key) ?? [];
      list.push(tx);
      days.set(key, list);
    }
    for (const [dayKey, qualifying] of [...days.entries()].sort()) {
      if (qualifying.length >= p.minTransactions) {
        const firing = qualifying[p.minTransactions - 1]!;
        hits.push({
          ruleCode: 'structuring_below_limit',
          severity: 'high',
          subjectType: 'agent',
          subjectId: agentId,
          firingEventId: firing.eventId,
          evidence: {
            lagosDate: dayKey,
            qualifyingCount: qualifying.length,
            minTransactions: p.minTransactions,
            withinPctOfLimit: p.withinPctOfLimit,
            dailyLimitKobo: agent.dailyLimitKobo,
            amountsKobo: qualifying.map((tx) => tx.amountKobo),
            eventIds: qualifying.map((tx) => tx.eventId)
          }
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// R3 — voucher_redemption_cluster
// ---------------------------------------------------------------------------

export interface VoucherClusterParams {
  windowMinutes: number;
  /** Supplier-side leg: distinct farmers served within the window. */
  minDistinctFarmers: number;
  /** Farmer-side leg: redemptions in ONE programme within the window above this fire (replay). */
  maxRedemptionsPerFarmerProgramme: number;
}

export const VOUCHER_CLUSTER_DEFAULTS: VoucherClusterParams = {
  windowMinutes: 60,
  minDistinctFarmers: 3,
  maxRedemptionsPerFarmerProgramme: 1
};

/**
 * R3: two legs over inputvouchers.voucher.redeemed.
 *   (a) supplier cluster — a single supplier redeems vouchers for
 *       minDistinctFarmers DISTINCT farmers within windowMinutes. DEVIATION
 *       from spec: the outbox payload carries no device fingerprint or H3
 *       cell, so the shared-identity dimension is supplierId.
 *   (b) farmer replay — the same farmer redeems more than
 *       maxRedemptionsPerFarmerProgramme vouchers in the SAME programme
 *       within the window (voucher replay cluster).
 * Crossing semantics: each leg fires on the event that first completes the
 * pattern; a growing cluster re-fires only when a NEW distinct farmer (leg a)
 * or a NEW replay count (leg b) completes.
 */
export function evaluateVoucherRedemptionCluster(
  input: SentinelRuleInput,
  params: RuleParams
): RuleHit[] {
  const p: VoucherClusterParams = {
    windowMinutes: numParam(params, 'windowMinutes', VOUCHER_CLUSTER_DEFAULTS.windowMinutes),
    minDistinctFarmers: numParam(params, 'minDistinctFarmers', VOUCHER_CLUSTER_DEFAULTS.minDistinctFarmers),
    maxRedemptionsPerFarmerProgramme: numParam(
      params,
      'maxRedemptionsPerFarmerProgramme',
      VOUCHER_CLUSTER_DEFAULTS.maxRedemptionsPerFarmerProgramme
    )
  };
  const windowMs = p.windowMinutes * MINUTE_MS;
  const redemptions = input.events
    .map(asVoucherRedemption)
    .filter((view): view is VoucherRedemptionView => view !== undefined);
  const hits: RuleHit[] = [];

  // (a) supplier cluster — fire when the trailing-window distinct-farmer
  // count first REACHES the threshold (once per cluster onset).
  const bySupplier = new Map<string, VoucherRedemptionView[]>();
  for (const redemption of redemptions) {
    if (!redemption.supplierId || !redemption.farmerId) {
      continue;
    }
    const list = bySupplier.get(redemption.supplierId) ?? [];
    list.push(redemption);
    bySupplier.set(redemption.supplierId, list);
  }
  for (const [supplierId, list] of bySupplier) {
    for (const [index, current] of list.entries()) {
      const windowStart = new Date(current.occurredAt).getTime() - windowMs;
      // Stream-position-bounded window: only events AT OR BEFORE the current
      // one, so same-millisecond timestamp ties cannot leak later events
      // into earlier evaluations (deterministic under replay).
      const windowEvents = list
        .slice(0, index + 1)
        .filter((other) => new Date(other.occurredAt).getTime() > windowStart);
      const distinctFarmers = new Set(windowEvents.map((other) => other.farmerId));
      if (distinctFarmers.size === p.minDistinctFarmers) {
        hits.push({
          ruleCode: 'voucher_redemption_cluster',
          severity: 'medium',
          subjectType: 'account',
          subjectId: supplierId,
          firingEventId: current.eventId,
          evidence: {
            basis: 'supplier_farmer_spread',
            windowMinutes: p.windowMinutes,
            distinctFarmers: distinctFarmers.size,
            minDistinctFarmers: p.minDistinctFarmers,
            farmerIds: [...distinctFarmers].sort(),
            eventIds: windowEvents.map((other) => other.eventId)
          }
        });
      }
    }
  }

  // (b) farmer replay — same farmer, same programme, count crossing
  // maxRedemptionsPerFarmerProgramme within the window.
  const byFarmerProgramme = new Map<string, VoucherRedemptionView[]>();
  for (const redemption of redemptions) {
    if (!redemption.farmerId || !redemption.programmeId) {
      continue;
    }
    const key = `${redemption.farmerId}|${redemption.programmeId}`;
    const list = byFarmerProgramme.get(key) ?? [];
    list.push(redemption);
    byFarmerProgramme.set(key, list);
  }
  for (const [key, list] of byFarmerProgramme) {
    const [farmerId, programmeId] = key.split('|');
    for (const [index, current] of list.entries()) {
      const windowStart = new Date(current.occurredAt).getTime() - windowMs;
      const windowEvents = list
        .slice(0, index + 1)
        .filter((other) => new Date(other.occurredAt).getTime() > windowStart);
      if (windowEvents.length === p.maxRedemptionsPerFarmerProgramme + 1) {
        hits.push({
          ruleCode: 'voucher_redemption_cluster',
          severity: 'high',
          subjectType: 'voucher',
          subjectId: current.voucherId,
          firingEventId: current.eventId,
          evidence: {
            basis: 'farmer_programme_replay',
            windowMinutes: p.windowMinutes,
            redemptionCount: windowEvents.length,
            maxRedemptionsPerFarmerProgramme: p.maxRedemptionsPerFarmerProgramme,
            farmerId,
            programmeId,
            voucherIds: windowEvents.map((other) => other.voucherId),
            eventIds: windowEvents.map((other) => other.eventId)
          }
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// R4 — float_cycle_wash
// ---------------------------------------------------------------------------

export interface FloatCycleParams {
  windowHours: number;
  /** |cash_in − cash_out| must be <= this % of gross for the wash signature. */
  maxNetRatioPct: number;
  /** Gross volume floor (kobo) — small churn is normal float operation. */
  minGrossKobo: number;
  minTransactions: number;
}

export const FLOAT_CYCLE_DEFAULTS: FloatCycleParams = {
  windowHours: 24,
  maxNetRatioPct: 1,
  minGrossKobo: 100_000_000, // ₦1,000,000
  minTransactions: 6
};

/**
 * R4: rolling windowHours window per agent; fire on the TRANSITION into the
 * wash signature (gross >= floor, count >= floor, net <= maxNetRatioPct of
 * gross) — the first event that completes a qualifying window, not every
 * event inside one. Deterministic given the ordered stream.
 */
export function evaluateFloatCycleWash(input: SentinelRuleInput, params: RuleParams): RuleHit[] {
  const p: FloatCycleParams = {
    windowHours: numParam(params, 'windowHours', FLOAT_CYCLE_DEFAULTS.windowHours),
    maxNetRatioPct: numParam(params, 'maxNetRatioPct', FLOAT_CYCLE_DEFAULTS.maxNetRatioPct),
    minGrossKobo: numParam(params, 'minGrossKobo', FLOAT_CYCLE_DEFAULTS.minGrossKobo),
    minTransactions: numParam(params, 'minTransactions', FLOAT_CYCLE_DEFAULTS.minTransactions)
  };
  const windowMs = p.windowHours * HOUR_MS;
  const hits: RuleHit[] = [];
  for (const [agentId, txs] of agentTransactions(input)) {
    let inWash = false;
    for (const [index, current] of txs.entries()) {
      const windowStart = new Date(current.occurredAt).getTime() - windowMs;
      const windowEvents = txs
        .slice(0, index + 1)
        .filter((other) => new Date(other.occurredAt).getTime() > windowStart);
      const cashInKobo = windowEvents
        .filter((other) => other.type === 'cash_in')
        .reduce((total, other) => total + other.amountKobo, 0);
      const cashOutKobo = windowEvents
        .filter((other) => other.type === 'cash_out')
        .reduce((total, other) => total + other.amountKobo, 0);
      const grossKobo = cashInKobo + cashOutKobo;
      const netKobo = Math.abs(cashInKobo - cashOutKobo);
      const qualifies =
        grossKobo >= p.minGrossKobo &&
        windowEvents.length >= p.minTransactions &&
        netKobo * 100 <= grossKobo * p.maxNetRatioPct;
      if (qualifies && !inWash) {
        hits.push({
          ruleCode: 'float_cycle_wash',
          severity: 'medium',
          subjectType: 'agent',
          subjectId: agentId,
          firingEventId: current.eventId,
          evidence: {
            windowHours: p.windowHours,
            grossKobo,
            cashInKobo,
            cashOutKobo,
            netKobo,
            maxNetRatioPct: p.maxNetRatioPct,
            transactionCount: windowEvents.length,
            eventIds: windowEvents.map((other) => other.eventId)
          }
        });
      }
      inWash = qualifies;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// R5 — dormancy_burst
// ---------------------------------------------------------------------------

export interface DormancyBurstParams {
  dormantDays: number;
  /** Absolute floor (kobo) so small post-dormancy amounts never fire. */
  minBurstKobo: number;
  /** Amount must also exceed p99(prior amounts) × this when history exists. */
  burstMultiplier: number;
}

export const DORMANCY_BURST_DEFAULTS: DormancyBurstParams = {
  dormantDays: 30,
  minBurstKobo: 200_000_000, // ₦2,000,000
  burstMultiplier: 3
};

/**
 * R5: fire when an agent transacts after >= dormantDays of inactivity AND the
 * amount exceeds BOTH minBurstKobo AND (when prior history exists) the agent's
 * own p99 amount × burstMultiplier. Dormancy is measured from the previous
 * transaction, or from the agent's registration event when there is no prior
 * transaction in the stream; an agent with neither in the stream is skipped
 * (ambiguous basis — fail quiet, never fabricate).
 */
export function evaluateDormancyBurst(input: SentinelRuleInput, params: RuleParams): RuleHit[] {
  const p: DormancyBurstParams = {
    dormantDays: numParam(params, 'dormantDays', DORMANCY_BURST_DEFAULTS.dormantDays),
    minBurstKobo: numParam(params, 'minBurstKobo', DORMANCY_BURST_DEFAULTS.minBurstKobo),
    burstMultiplier: numParam(params, 'burstMultiplier', DORMANCY_BURST_DEFAULTS.burstMultiplier)
  };
  const registeredAt = new Map<string, string>();
  for (const event of input.events) {
    if (event.name !== 'agentbank.agent.registered') {
      continue;
    }
    const agentId = event.payload.agentId;
    if (typeof agentId === 'string' && !registeredAt.has(agentId)) {
      registeredAt.set(agentId, event.occurredAt);
    }
  }
  const hits: RuleHit[] = [];
  for (const [agentId, txs] of agentTransactions(input)) {
    const priorAmounts: number[] = [];
    let lastActivityAt: string | undefined = registeredAt.get(agentId);
    for (const tx of txs) {
      if (lastActivityAt) {
        const gapMs = new Date(tx.occurredAt).getTime() - new Date(lastActivityAt).getTime();
        if (gapMs >= p.dormantDays * DAY_MS && tx.amountKobo >= p.minBurstKobo) {
          const p99 = percentileNearestRank(priorAmounts, 99);
          const statisticalThreshold = p99 !== undefined ? p99 * p.burstMultiplier : 0;
          if (tx.amountKobo > statisticalThreshold) {
            hits.push({
              ruleCode: 'dormancy_burst',
              severity: 'high',
              subjectType: 'agent',
              subjectId: agentId,
              firingEventId: tx.eventId,
              evidence: {
                dormantDays: p.dormantDays,
                gapDays: Math.floor(gapMs / DAY_MS),
                previousActivityAt: lastActivityAt,
                amountKobo: tx.amountKobo,
                minBurstKobo: p.minBurstKobo,
                historicalP99Kobo: p99 ?? null,
                burstMultiplier: p.burstMultiplier,
                baselineTransactions: priorAmounts.length
              }
            });
          }
        }
      }
      priorAmounts.push(tx.amountKobo);
      lastActivityAt = tx.occurredAt;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// R6 — float_depletion
// ---------------------------------------------------------------------------

/**
 * R6: replays finance.ledger.entry_posted in stream order, maintaining a
 * running balance per agent float account (debit + / credit − on the asset
 * account). Fires on the TRANSITION from above to at-or-below the agent's
 * configured lowFloatThresholdKobo, and only when the firing entry actually
 * drew the balance down. An agent whose stream history starts with the float
 * already at/below the threshold never alerts (the balance was never SEEN
 * above it — the crossing requirement makes mid-stream catch-up fail quiet
 * instead of false-alarming on an unknowable opening balance). Entries
 * missing from the ledgerEntries view are skipped (projector-style rebuild
 * tolerance).
 */
export function evaluateFloatDepletion(input: SentinelRuleInput): RuleHit[] {
  // floatAccountCode → agent context.
  const byAccount = new Map<string, AgentRuleContext>();
  for (const agent of input.agents.values()) {
    byAccount.set(agent.floatAccountCode, agent);
  }
  const balances = new Map<string, number>();
  const hits: RuleHit[] = [];
  for (const event of input.events) {
    if (event.name !== 'finance.ledger.entry_posted') {
      continue;
    }
    const entryId = event.payload.entryId;
    if (typeof entryId !== 'string') {
      continue;
    }
    const entry = input.ledgerEntries.get(entryId);
    if (!entry) {
      continue; // entry not resolvable — skip, a later related event can rebuild
    }
    for (const posting of entry.postings) {
      const agent = byAccount.get(posting.accountCode);
      if (!agent) {
        continue;
      }
      const previous = balances.get(posting.accountCode) ?? 0;
      const delta = posting.direction === 'debit' ? posting.amountKobo : -posting.amountKobo;
      const next = previous + delta;
      balances.set(posting.accountCode, next);
      if (
        delta < 0 &&
        previous > agent.lowFloatThresholdKobo &&
        next <= agent.lowFloatThresholdKobo
      ) {
        hits.push({
          ruleCode: 'float_depletion',
          severity: 'low',
          subjectType: 'agent',
          subjectId: agent.agentId,
          firingEventId: event.id,
          evidence: {
            basis: 'stream_computed_float_balance',
            floatAccountCode: posting.accountCode,
            balanceBeforeKobo: previous,
            balanceAfterKobo: next,
            lowFloatThresholdKobo: agent.lowFloatThresholdKobo,
            ledgerEntryId: entryId
          }
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// R7 — duplicate_amount_burst
// ---------------------------------------------------------------------------

export interface DuplicateAmountParams {
  windowMinutes: number;
  /** Identical-amount transactions at one agent within the window that fire. */
  minCount: number;
}

export const DUPLICATE_AMOUNT_DEFAULTS: DuplicateAmountParams = {
  windowMinutes: 30,
  minCount: 3
};

/**
 * R7: per agent per exact amount, fire when the trailing windowMinutes count
 * first REACHES minCount identical-amount transactions (replay/scripting
 * signature). Crossing semantics: the alert fires on the minCount-th event;
 * further identical events extend evidence via the case, not new alerts,
 * until the count dips below the threshold and re-crosses.
 */
export function evaluateDuplicateAmountBurst(
  input: SentinelRuleInput,
  params: RuleParams
): RuleHit[] {
  const p: DuplicateAmountParams = {
    windowMinutes: numParam(params, 'windowMinutes', DUPLICATE_AMOUNT_DEFAULTS.windowMinutes),
    minCount: numParam(params, 'minCount', DUPLICATE_AMOUNT_DEFAULTS.minCount)
  };
  const windowMs = p.windowMinutes * MINUTE_MS;
  const hits: RuleHit[] = [];
  for (const [agentId, txs] of agentTransactions(input)) {
    const byAmount = new Map<number, AgentTxView[]>();
    for (const tx of txs) {
      const list = byAmount.get(tx.amountKobo) ?? [];
      list.push(tx);
      byAmount.set(tx.amountKobo, list);
    }
    for (const [amountKobo, list] of byAmount) {
      for (const [index, current] of list.entries()) {
        const windowStart = new Date(current.occurredAt).getTime() - windowMs;
        const windowEvents = list
          .slice(0, index + 1)
          .filter((other) => new Date(other.occurredAt).getTime() > windowStart);
        if (windowEvents.length === p.minCount) {
          hits.push({
            ruleCode: 'duplicate_amount_burst',
            severity: 'medium',
            subjectType: 'agent',
            subjectId: agentId,
            firingEventId: current.eventId,
            evidence: {
              windowMinutes: p.windowMinutes,
              amountKobo,
              count: windowEvents.length,
              minCount: p.minCount,
              eventIds: windowEvents.map((other) => other.eventId)
            }
          });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Catalog + param validation (fail-closed: unknown codes/params are rejected
// before a new rule version is persisted).
// ---------------------------------------------------------------------------

export interface SentinelRuleDefinition {
  code: string;
  defaults: RuleParams;
  evaluate: SentinelRuleEvaluator;
}

export const SENTINEL_RULE_CATALOG: readonly SentinelRuleDefinition[] = [
  {
    code: 'agent_daily_velocity',
    defaults: { ...AGENT_DAILY_VELOCITY_DEFAULTS },
    evaluate: evaluateAgentDailyVelocity
  },
  {
    code: 'structuring_below_limit',
    defaults: { ...STRUCTURING_DEFAULTS },
    evaluate: evaluateStructuringBelowLimit
  },
  {
    code: 'voucher_redemption_cluster',
    defaults: { ...VOUCHER_CLUSTER_DEFAULTS },
    evaluate: evaluateVoucherRedemptionCluster
  },
  {
    code: 'float_cycle_wash',
    defaults: { ...FLOAT_CYCLE_DEFAULTS },
    evaluate: evaluateFloatCycleWash
  },
  {
    code: 'dormancy_burst',
    defaults: { ...DORMANCY_BURST_DEFAULTS },
    evaluate: evaluateDormancyBurst
  },
  { code: 'float_depletion', defaults: {}, evaluate: (input) => evaluateFloatDepletion(input) },
  {
    code: 'duplicate_amount_burst',
    defaults: { ...DUPLICATE_AMOUNT_DEFAULTS },
    evaluate: evaluateDuplicateAmountBurst
  }
];

export function sentinelRuleDefinition(code: string): SentinelRuleDefinition | undefined {
  return SENTINEL_RULE_CATALOG.find((definition) => definition.code === code);
}

/**
 * Validates a params object for a rule: every key must exist in the rule's
 * defaults with a finite-number value (or the defaults themselves for a rule
 * with no tunables). Returns the validated params; throws Error otherwise.
 */
export function validateRuleParams(code: string, params: RuleParams): RuleParams {
  const definition = sentinelRuleDefinition(code);
  if (!definition) {
    throw new Error(`Unknown fraud rule code '${code}'`);
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Rule params must be a plain object');
  }
  for (const [key, value] of Object.entries(params)) {
    if (!(key in definition.defaults)) {
      throw new Error(
        `Unknown param '${key}' for rule '${code}' (known: ${Object.keys(definition.defaults).join(', ') || 'none'})`
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Param '${key}' for rule '${code}' must be a finite number`);
    }
  }
  return { ...params };
}
