import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  AGENT_FLOAT_TOPUP_REPOSITORY,
  AGENT_TRANSACTION_REPOSITORY,
  AGENT_VOUCHER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AgentBankingAgentRepository,
  AgentFloatTopUpRecord,
  AgentFloatTopUpRepository,
  AgentRecord,
  AgentStatus,
  AgentTopUpStatus,
  AgentTransactionRecord,
  AgentTransactionRepository,
  AgentTransactionType,
  AgentVoucherRecord,
  AgentVoucherRepository
} from '../../database/repositories/agent-banking.repository.js';
import {
  MOJALOOP_ADAPTER,
  type MojaloopAdapter,
  type MojaloopAdapterStatus,
  type MojaloopQuote
} from '../integrations/drivers/mojaloop.driver.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { commissionFor, type CommissionableType } from './commission.js';
import { OTP_DRIVER_TOKEN, OtpVerificationError, type OtpDriver } from './otp.driver.js';
import { resolveVoucherSecret, signVoucher, verifyVoucherSignature } from './voucher-crypto.js';

/** Default per-agent daily cash-in/out limit: N250,000. */
export const DEFAULT_AGENT_DAILY_LIMIT_KOBO = 25_000_000;
/** Default low-float flag threshold: N20,000. */
export const DEFAULT_LOW_FLOAT_THRESHOLD_KOBO = 2_000_000;
/** Default voucher validity window: 72 hours. */
export const DEFAULT_VOUCHER_TTL_MS = 72 * 60 * 60 * 1000;

export const AGENT_FLOAT_ACCOUNT_PREFIX = 'agent';
export const PLATFORM_COMMISSION_EXPENSE_ACCOUNT = 'platform:commission_expense';
export const PLATFORM_CASH_ACCOUNT = 'platform:cash';

/**
 * Bounded-retry probe discipline for crash-safe rollback legs (stage 24,
 * audit A1-6): 3 attempts with 50–150ms jitter ride out the visibility
 * window between a twin's committed posting and our 23505.
 */
export const LEDGER_PROBE_ATTEMPTS = 3;
export const LEDGER_PROBE_BASE_DELAY_MS = 50;
export const LEDGER_PROBE_JITTER_MS = 101;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function agentFloatAccountCode(agentId: string): string {
  return `agent:${agentId}:float`;
}

export function agentCommissionAccountCode(agentId: string): string {
  return `agent:${agentId}:commission_payable`;
}

export function farmerWalletAccountCode(farmerId: string): string {
  return `member:${farmerId}:wallet`;
}

export interface RegisterAgentInput {
  userId: string;
  organisation: string;
  dailyLimitKobo?: number;
  lowFloatThresholdKobo?: number;
}

export interface FloatBalanceView {
  agentId: string;
  floatAccountCode: string;
  balanceKobo: number;
  lowFloatThresholdKobo: number;
  /** True when the float is at/below the configured low-float threshold. */
  lowFloat: boolean;
}

export interface CashTransactionInput {
  farmerId: string;
  amountKobo: number;
  /** Farmer presence proof (OTP) — verified via the OTP driver port. */
  otp: string;
  /** Mandatory client idempotency key; replays return the original record. */
  idempotencyKey: string;
}

export interface TopUpRequestInput {
  amountKobo: number;
  /**
   * Mandatory client idempotency key (stage 22, audit C2-9); replays return
   * the original top-up request instead of creating a second settleable row.
   */
  idempotencyKey: string;
}

export interface IssueVoucherInput {
  farmerId: string;
  amountKobo: number;
  /** Optional ISO expiry; defaults to now + 72h. */
  expiresAt?: string;
  /**
   * Mandatory client idempotency key (stage 22, audit C2-10): a keyless
   * issuance request is rejected with 400 — a keyless retry would duplicate
   * a signed, money-bearing voucher. NULL keys remain only on rows that
   * predate this requirement (038 keeps the partial UNIQUE index).
   */
  idempotencyKey: string;
}

export interface CommissionStatementRow {
  type: CommissionableType;
  count: number;
  volumeKobo: number;
  commissionKobo: number;
}

export interface CommissionStatement {
  agentId: string;
  month: string;
  rows: CommissionStatementRow[];
  totalCommissionKobo: number;
  /** Ledger balance of the commission payable account (credits - debits). */
  commissionPayableKobo: number;
}

export interface AgentReconciliation {
  agentId: string;
  date: string;
  openingFloatKobo: number;
  closingFloatKobo: number;
  volumeByType: Record<'cash_in' | 'cash_out' | 'voucher_redemption' | 'float_topup', number>;
  commissionAccruedKobo: number;
  transactionCount: number;
}

export interface ActorRef {
  id: string;
  roles: readonly string[];
}

function assertPositiveKobo(amountKobo: number, field = 'amountKobo'): void {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new BadRequestException(`${field} must be a positive integer kobo value`);
  }
}

function dayBounds(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new BadRequestException('date must be YYYY-MM-DD');
  }
  return { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` };
}

function monthBounds(month: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new BadRequestException('month must be YYYY-MM');
  }
  const [year, m] = month.split('-').map((part) => Number.parseInt(part, 10));
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01T00:00:00.000Z`, to: `${month}-${String(last).padStart(2, '0')}T23:59:59.999Z` };
}

/**
 * Agent banking service (wave AGENTBANK). ALL value movement posts through
 * LedgerService — the agent float is a ledger sub-account
 * (agent:<id>:float), never a parallel money store:
 *   cash-in   : DR member:<farmer>:wallet / CR agent float (float ≥ 0 guarded)
 *   cash-out  : DR agent float / CR member:<farmer>:wallet (wallet ≥ 0 guarded)
 *   top-up    : DR agent float / CR platform:cash (platform:cash ≥ 0 guarded)
 *   commission: DR platform:commission_expense / CR agent commission payable
 * Solvency checks run inside the ledger posting transaction, so overdrafts
 * are impossible — an underfunded posting rolls back atomically.
 */
@Injectable()
export class AgentBankingService {
  private readonly voucherSecret: string;

  constructor(
    @Inject(AGENT_BANKING_AGENT_REPOSITORY) private readonly agents: AgentBankingAgentRepository,
    @Inject(AGENT_FLOAT_TOPUP_REPOSITORY) private readonly topups: AgentFloatTopUpRepository,
    @Inject(AGENT_VOUCHER_REPOSITORY) private readonly vouchers: AgentVoucherRepository,
    @Inject(AGENT_TRANSACTION_REPOSITORY) private readonly transactions: AgentTransactionRepository,
    private readonly ledger: LedgerService,
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Inject(OTP_DRIVER_TOKEN) private readonly otp: OtpDriver,
    @Optional() @Inject(MOJALOOP_ADAPTER) private readonly mojaloop?: MojaloopAdapter,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.voucherSecret = resolveVoucherSecret(env);
  }

  // ---------------------------------------------------------------- agents

  async registerAgent(input: RegisterAgentInput, actorId: string): Promise<AgentRecord> {
    await this.users.getById(input.userId);
    if (await this.agents.findByUserId(input.userId)) {
      throw new ConflictException('This user is already registered as an agent');
    }
    const id = newId('agent');
    const now = new Date().toISOString();
    const dailyLimitKobo = input.dailyLimitKobo ?? DEFAULT_AGENT_DAILY_LIMIT_KOBO;
    const lowFloatThresholdKobo = input.lowFloatThresholdKobo ?? DEFAULT_LOW_FLOAT_THRESHOLD_KOBO;
    assertPositiveKobo(dailyLimitKobo, 'dailyLimitKobo');
    if (!Number.isSafeInteger(lowFloatThresholdKobo) || lowFloatThresholdKobo < 0) {
      throw new BadRequestException('lowFloatThresholdKobo must be a non-negative integer');
    }
    // The float and commission accounts are ledger sub-accounts owned by the
    // agent's user — created up-front so every later posting finds them.
    await this.ledger.ensureAccount({
      code: agentFloatAccountCode(id),
      type: 'asset',
      ownerId: input.userId
    });
    await this.ledger.ensureAccount({
      code: agentCommissionAccountCode(id),
      type: 'liability',
      ownerId: input.userId
    });
    const record = await this.agents.create({
      id,
      userId: input.userId,
      organisation: input.organisation,
      status: 'PENDING',
      floatAccountCode: agentFloatAccountCode(id),
      commissionAccountCode: agentCommissionAccountCode(id),
      dailyLimitKobo,
      lowFloatThresholdKobo,
      createdAt: now,
      updatedAt: now
    });
    await this.events.publish('agentbank.agent.registered', { agentId: id, userId: input.userId }, actorId);
    return record;
  }

  async getAgent(id: string): Promise<AgentRecord> {
    const agent = await this.agents.findById(id);
    if (!agent) {
      throw new NotFoundException(`Agent '${id}' not found`);
    }
    return agent;
  }

  async listAgents(status?: AgentStatus): Promise<AgentRecord[]> {
    return this.agents.find(status ? { status } : {});
  }

  /** Agent profile for the calling user (self-service). */
  async agentForUser(userId: string): Promise<AgentRecord> {
    const agent = await this.agents.findByUserId(userId);
    if (!agent) {
      throw new NotFoundException('No agent registration for this user');
    }
    return agent;
  }

  /** PENDING→ACTIVE, ACTIVE↔SUSPENDED. Other transitions are rejected. */
  async setAgentStatus(id: string, status: AgentStatus, actorId: string): Promise<AgentRecord> {
    const agent = await this.getAgent(id);
    if (agent.status === status) {
      return agent; // idempotent replay
    }
    const allowed: Record<AgentStatus, AgentStatus[]> = {
      PENDING: ['ACTIVE', 'SUSPENDED'],
      ACTIVE: ['SUSPENDED'],
      SUSPENDED: ['ACTIVE']
    };
    if (!allowed[agent.status].includes(status)) {
      throw new BadRequestException(
        `Agent status cannot move from ${agent.status} to ${status}`
      );
    }
    const updated = await this.agents.updateExpected(
      id,
      { status, updatedAt: new Date().toISOString() },
      { status: agent.status }
    );
    await this.events.publish(
      'agentbank.agent.status_changed',
      { agentId: id, from: agent.status, to: status },
      actorId
    );
    return updated;
  }

  async updateLimits(
    id: string,
    patch: { dailyLimitKobo?: number; lowFloatThresholdKobo?: number },
    actorId: string
  ): Promise<AgentRecord> {
    const agent = await this.getAgent(id);
    if (patch.dailyLimitKobo !== undefined) {
      assertPositiveKobo(patch.dailyLimitKobo, 'dailyLimitKobo');
    }
    if (
      patch.lowFloatThresholdKobo !== undefined &&
      (!Number.isSafeInteger(patch.lowFloatThresholdKobo) || patch.lowFloatThresholdKobo < 0)
    ) {
      throw new BadRequestException('lowFloatThresholdKobo must be a non-negative integer');
    }
    const updated = await this.agents.updateExpected(
      id,
      { ...patch, updatedAt: new Date().toISOString() },
      { updatedAt: agent.updatedAt }
    );
    await this.events.publish('agentbank.agent.limits_updated', { agentId: id }, actorId);
    return updated;
  }

  /** Caller must be the agent owner or an admin/supervisor. */
  assertAgentAccess(agent: AgentRecord, actor: ActorRef): void {
    if (actor.roles.includes('admin')) {
      return;
    }
    if (agent.userId !== actor.id) {
      throw new ForbiddenException('Only the agent owner or an admin can access this resource');
    }
  }

  private async activeAgent(agentId: string): Promise<AgentRecord> {
    const agent = await this.getAgent(agentId);
    if (agent.status !== 'ACTIVE') {
      throw new BadRequestException(`Agent must be ACTIVE to transact (status is ${agent.status})`);
    }
    return agent;
  }

  // ------------------------------------------------------------------ float

  async floatBalance(agentId: string): Promise<FloatBalanceView> {
    const agent = await this.getAgent(agentId);
    const balance = await this.ledger.balance(agent.floatAccountCode);
    return {
      agentId: agent.id,
      floatAccountCode: agent.floatAccountCode,
      balanceKobo: balance.balanceKobo,
      lowFloatThresholdKobo: agent.lowFloatThresholdKobo,
      lowFloat: balance.balanceKobo <= agent.lowFloatThresholdKobo
    };
  }

  async requestTopUp(agentId: string, input: TopUpRequestInput, actor: ActorRef): Promise<AgentFloatTopUpRecord> {
    const replay = await this.topups.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay; // idempotent replay of a transport retry
    }
    const agent = await this.activeAgent(agentId);
    this.assertAgentAccess(agent, actor);
    assertPositiveKobo(input.amountKobo);
    try {
      const record = await this.topups.create({
        id: newId('topup'),
        agentId,
        amountKobo: input.amountKobo,
        status: 'REQUESTED',
        requestedBy: actor.id,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'agentbank.topup.requested',
        { topUpId: record.id, agentId, amountKobo: input.amountKobo },
        actor.id
      );
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Lost a retry race — the original request is authoritative; return
        // it instead of creating a second settleable row.
        const existing = await this.topups.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async listTopUps(filter: { agentId?: string; status?: AgentTopUpStatus }): Promise<AgentFloatTopUpRecord[]> {
    return this.topups.find(filter);
  }

  async decideTopUp(
    id: string,
    decision: 'approve' | 'reject',
    actorId: string,
    rejectionReason?: string
  ): Promise<AgentFloatTopUpRecord> {
    const topup = await this.topups.findById(id);
    if (!topup) {
      throw new NotFoundException(`Float top-up '${id}' not found`);
    }
    if (decision === 'reject' && !rejectionReason?.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }
    const now = new Date().toISOString();
    // CAS on REQUESTED: a second decider loses the race and gets a 409.
    const updated = await this.topups.updateExpected(
      id,
      {
        status: decision === 'approve' ? 'APPROVED' : 'REJECTED',
        decidedBy: actorId,
        decidedAt: now,
        rejectionReason: decision === 'reject' ? rejectionReason?.trim() : undefined
      },
      { status: 'REQUESTED' }
    );
    await this.events.publish(
      'agentbank.topup.decided',
      { topUpId: id, decision: updated.status },
      actorId
    );
    return updated;
  }

  /**
   * Settles an approved top-up: posts DR agent float / CR platform:cash with
   * the platform:cash solvency guard, then advances APPROVED→SETTLED. The
   * ledger posting is idempotent on agent-float-topup:<id>.
   */
  async settleTopUp(id: string, actorId: string): Promise<AgentFloatTopUpRecord> {
    const topup = await this.topups.findById(id);
    if (!topup) {
      throw new NotFoundException(`Float top-up '${id}' not found`);
    }
    if (topup.status === 'SETTLED') {
      return topup; // idempotent replay
    }
    if (topup.status !== 'APPROVED') {
      throw new BadRequestException(`Only APPROVED top-ups can settle (status is ${topup.status})`);
    }
    const agent = await this.getAgent(topup.agentId);
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `agent-float-topup:${topup.id}`,
        referenceType: 'agent_banking_float_topup',
        referenceId: topup.id,
        description: `Agent float top-up for ${agent.id}`,
        postings: [
          { accountCode: agent.floatAccountCode, direction: 'debit', amountKobo: topup.amountKobo },
          { accountCode: PLATFORM_CASH_ACCOUNT, direction: 'credit', amountKobo: topup.amountKobo }
        ],
        requireSolventAccounts: [PLATFORM_CASH_ACCOUNT]
      },
      actorId
    );
    const updated = await this.topups.updateExpected(
      id,
      { status: 'SETTLED', settledAt: new Date().toISOString(), ledgerEntryId: entry.id },
      { status: 'APPROVED' }
    );
    await this.events.publish(
      'agentbank.topup.settled',
      { topUpId: id, agentId: agent.id, amountKobo: topup.amountKobo, ledgerEntryId: entry.id },
      actorId
    );
    return updated;
  }

  // ----------------------------------------------------------- cash-in/out

  async cashIn(agentId: string, input: CashTransactionInput, actor: ActorRef): Promise<AgentTransactionRecord> {
    return this.cashTransaction('cash_in', agentId, input, actor);
  }

  async cashOut(agentId: string, input: CashTransactionInput, actor: ActorRef): Promise<AgentTransactionRecord> {
    return this.cashTransaction('cash_out', agentId, input, actor);
  }

  private async cashTransaction(
    type: 'cash_in' | 'cash_out',
    agentId: string,
    input: CashTransactionInput,
    actor: ActorRef
  ): Promise<AgentTransactionRecord> {
    const actorId = actor.id;
    const replay = await this.transactions.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay; // idempotent replay of a transport retry
    }
    const agent = await this.activeAgent(agentId);
    this.assertAgentAccess(agent, actor);
    assertPositiveKobo(input.amountKobo);
    await this.users.getById(input.farmerId);
    try {
      await this.otp.verify(input.farmerId, input.idempotencyKey, input.otp);
    } catch (error) {
      if (error instanceof OtpVerificationError) {
        throw new UnauthorizedException('Farmer presence proof failed (invalid OTP)');
      }
      throw error; // fail-closed driver errors (e.g. live 503) propagate
    }
    await this.assertWithinDailyLimit(agent, input.amountKobo);

    const walletCode = farmerWalletAccountCode(input.farmerId);
    await this.ledger.ensureAccount({ code: walletCode, type: 'asset', ownerId: input.farmerId });
    const txId = newId('agtx');
    // Double-entry through the ledger with the solvency guard on the account
    // being drawn down — overdraft is impossible by construction.
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `agent-tx:${input.idempotencyKey}`,
        referenceType: type === 'cash_in' ? 'agent_banking_cash_in' : 'agent_banking_cash_out',
        referenceId: txId,
        description:
          type === 'cash_in'
            ? `Cash-in at agent ${agent.id} for farmer ${input.farmerId}`
            : `Cash-out at agent ${agent.id} for farmer ${input.farmerId}`,
        postings:
          type === 'cash_in'
            ? [
                { accountCode: walletCode, direction: 'debit', amountKobo: input.amountKobo },
                { accountCode: agent.floatAccountCode, direction: 'credit', amountKobo: input.amountKobo }
              ]
            : [
                { accountCode: agent.floatAccountCode, direction: 'debit', amountKobo: input.amountKobo },
                { accountCode: walletCode, direction: 'credit', amountKobo: input.amountKobo }
              ],
        requireSolventAccounts: [type === 'cash_in' ? agent.floatAccountCode : walletCode]
      },
      actorId
    );
    const commissionKobo = await this.accrueCommission(agent, type, input.amountKobo, input.idempotencyKey, txId, actorId);
    try {
      const record = await this.transactions.create({
        id: txId,
        agentId: agent.id,
        farmerId: input.farmerId,
        type,
        amountKobo: input.amountKobo,
        commissionKobo,
        idempotencyKey: input.idempotencyKey,
        ledgerEntryId: entry.id,
        // Persist the presence-proof basis so a stub-OTP-backed cash movement
        // is always identifiable as such (stub is non-production only).
        otpBasis: this.otp.name,
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'agentbank.transaction.posted',
        { transactionId: txId, agentId: agent.id, farmerId: input.farmerId, type, amountKobo: input.amountKobo },
        actorId
      );
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Lost a retry race after the ledger posting landed — the original
        // record is authoritative; return it instead of double-posting.
        const existing = await this.transactions.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  private async assertWithinDailyLimit(agent: AgentRecord, amountKobo: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const { from, to } = dayBounds(today);
    const todays = await this.transactions.find({ agentId: agent.id, from, to });
    const used = todays.reduce((sum, tx) => sum + tx.amountKobo, 0);
    if (used + amountKobo > agent.dailyLimitKobo) {
      throw new BadRequestException(
        `Agent daily limit exceeded: ${used + amountKobo} kobo would pass the ${agent.dailyLimitKobo} kobo daily limit`
      );
    }
  }

  /** Posts the commission accrual entry; returns the accrued kobo. */
  private async accrueCommission(
    agent: AgentRecord,
    type: CommissionableType,
    amountKobo: number,
    idempotencyKey: string,
    referenceId: string,
    actorId: string
  ): Promise<number> {
    const commissionKobo = commissionFor(type, amountKobo);
    if (commissionKobo <= 0) {
      return 0;
    }
    await this.ledger.ensureAccount({ code: PLATFORM_COMMISSION_EXPENSE_ACCOUNT, type: 'expense' });
    await this.ledger.postEntry(
      {
        idempotencyKey: `agent-commission:${idempotencyKey}`,
        referenceType: 'agent_banking_commission',
        referenceId,
        description: `Agent commission accrual (${type}) for ${agent.id}`,
        postings: [
          { accountCode: PLATFORM_COMMISSION_EXPENSE_ACCOUNT, direction: 'debit', amountKobo: commissionKobo },
          { accountCode: agent.commissionAccountCode, direction: 'credit', amountKobo: commissionKobo }
        ]
      },
      actorId
    );
    return commissionKobo;
  }

  // ------------------------------------------- crash-safe claim discipline

  /**
   * Bounded-retry ledger truth probe (stage 24, audit A1-6/A4-1). A racing
   * twin's commit can become visible a beat AFTER its 23505 reached us, so
   * one lookup is not proof of absence. 'absent' means every probe succeeded
   * and found nothing — the only state in which a claim may roll back;
   * 'unknown' (the probe itself failed) must be treated like 'found': when
   * in doubt, leave the pending state for resume and surface 409.
   */
  private async probeLedgerEntry(key: string): Promise<'found' | 'absent' | 'unknown'> {
    let sawFailure = false;
    for (let attempt = 0; attempt < LEDGER_PROBE_ATTEMPTS; attempt += 1) {
      try {
        if (await this.ledger.findEntryByIdempotencyKey(key)) {
          return 'found';
        }
      } catch {
        sawFailure = true; // the probe itself failed — we know nothing
      }
      if (attempt < LEDGER_PROBE_ATTEMPTS - 1) {
        await sleep(LEDGER_PROBE_BASE_DELAY_MS + Math.floor(Math.random() * LEDGER_PROBE_JITTER_MS));
      }
    }
    return sawFailure ? 'unknown' : 'absent';
  }

  /**
   * Bounded-retry adoption probe for the transaction row: a twin that beat
   * us to the ledger insert (23505) writes its transaction row a beat later,
   * so a single-shot lookup could miss and drop into the rollback leg while
   * the twin's payout stands (audit A1-6).
   */
  private async probeTransactionRow(key: string): Promise<AgentTransactionRecord | undefined> {
    for (let attempt = 0; attempt < LEDGER_PROBE_ATTEMPTS; attempt += 1) {
      try {
        const row = await this.transactions.findByIdempotencyKey(key);
        if (row) {
          return row;
        }
      } catch {
        // lookup hiccup — retry within the bound
      }
      if (attempt < LEDGER_PROBE_ATTEMPTS - 1) {
        await sleep(LEDGER_PROBE_BASE_DELAY_MS + Math.floor(Math.random() * LEDGER_PROBE_JITTER_MS));
      }
    }
    return undefined;
  }

  async listTransactions(
    filter: { agentId?: string; farmerId?: string; type?: AgentTransactionType; from?: string; to?: string }
  ): Promise<AgentTransactionRecord[]> {
    return this.transactions.find(filter);
  }

  // --------------------------------------------------------------- vouchers

  async issueVoucher(agentId: string, input: IssueVoucherInput, actor: ActorRef): Promise<AgentVoucherRecord> {
    // The key is mandatory at the API layer (stage 22, audit C2-10): keyless
    // issuance is rejected — a keyless retry duplicates signed money-bearing
    // vouchers. Service-level guard so non-HTTP callers cannot bypass it.
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required — voucher issuance must be replay-safe');
    }
    const replay = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay; // idempotent replay of a transport retry
    }
    const agent = await this.activeAgent(agentId);
    this.assertAgentAccess(agent, actor);
    assertPositiveKobo(input.amountKobo);
    await this.users.getById(input.farmerId);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_VOUCHER_TTL_MS).toISOString();
    if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new BadRequestException('expiresAt must be a future ISO-8601 timestamp');
    }
    const id = newId('voucher');
    const nonce = randomUUID();
    const signature = signVoucher(
      { voucherId: id, agentId: agent.id, farmerId: input.farmerId, amountKobo: input.amountKobo, expiry: expiresAt, nonce },
      this.voucherSecret
    );
    try {
      const record = await this.vouchers.create({
        id,
        agentId: agent.id,
        farmerId: input.farmerId,
        amountKobo: input.amountKobo,
        expiresAt,
        nonce,
        signature,
        status: 'ISSUED',
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'agentbank.voucher.issued',
        { voucherId: id, agentId: agent.id, farmerId: input.farmerId, amountKobo: input.amountKobo },
        actor.id
      );
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Lost a retry race — the original voucher is authoritative; return
        // it instead of issuing a duplicate.
        const existing = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async getVoucher(id: string): Promise<AgentVoucherRecord> {
    const voucher = await this.vouchers.findById(id);
    if (!voucher) {
      throw new NotFoundException(`Voucher '${id}' not found`);
    }
    return voucher;
  }

  async listVouchers(filter: { agentId?: string; farmerId?: string; status?: AgentVoucherRecord['status'] }): Promise<AgentVoucherRecord[]> {
    return this.vouchers.find(filter);
  }

  /**
   * Redeems a signed voucher: verifies the HMAC server-side, checks the
   * state machine and expiry, then settles through the ledger. Anti-race
   * (stage 22, audit C3/C2-9 — escrow pending-state pattern): the voucher
   * CASes ISSUED→REDEEMING BEFORE the ledger posting (idempotency key
   * voucher-redemption:<id>), so a concurrent void loses the same CAS and
   * cannot interleave with the payout; only the claim holder posts. A retry
   * that finds REDEEMING with the transaction row already present completes
   * finalization instead of reposting; on posting failure the claim rolls
   * back REDEEMING→ISSUED best-effort. A replay after redemption is a 409 —
   * a voucher can pay out exactly once.
   */
  async redeemVoucher(
    id: string,
    presentedSignature: string | undefined,
    actor: ActorRef
  ): Promise<{ voucher: AgentVoucherRecord; transaction: AgentTransactionRecord }> {
    let voucher = await this.getVoucher(id);
    if (voucher.status === 'REDEEMED') {
      throw new ConflictException(`Voucher '${id}' has already been redeemed`);
    }
    if (voucher.status === 'VOIDED') {
      throw new ConflictException(`Voucher '${id}' was voided`);
    }
    if (voucher.status === 'EXPIRED') {
      throw new GoneException(`Voucher '${id}' expired at ${voucher.expiresAt}`);
    }
    // A REDEEMING voucher resumes below regardless of the expiry clock — the
    // claim was taken while the voucher was valid and must settle exactly once.
    if (voucher.status === 'ISSUED' && Date.parse(voucher.expiresAt) <= Date.now()) {
      await this.vouchers.updateExpected(id, { status: 'EXPIRED' }, { status: 'ISSUED' });
      throw new GoneException(`Voucher '${id}' expired at ${voucher.expiresAt}`);
    }
    // Server-side signature verification: the presented signature must be a
    // valid HMAC over the stored payload AND match the stored signature. The
    // USSD path omits the presentation (the agent's authenticated session is
    // the possession proof); the stored signature is verified either way.
    const presented = presentedSignature ?? voucher.signature;
    const payload = {
      voucherId: voucher.id,
      agentId: voucher.agentId,
      farmerId: voucher.farmerId,
      amountKobo: voucher.amountKobo,
      expiry: voucher.expiresAt,
      nonce: voucher.nonce
    };
    if (
      presented !== voucher.signature ||
      !verifyVoucherSignature(payload, presented, this.voucherSecret)
    ) {
      throw new UnauthorizedException('Voucher signature verification failed');
    }
    const agent = await this.activeAgent(voucher.agentId);
    // Redeemer must be the farmer themself, the issuing agent, or an admin.
    if (!actor.roles.includes('admin') && actor.id !== voucher.farmerId && actor.id !== agent.userId) {
      throw new ForbiddenException('Only the farmer, the issuing agent or an admin can redeem this voucher');
    }
    if (voucher.status === 'ISSUED') {
      // Claim the redemption FIRST: after this write a concurrent void (or
      // second redeem) loses its CAS and surfaces as a 409 — the void can no
      // longer interleave between the ledger posting and the state advance.
      voucher = await this.vouchers.updateExpected(id, { status: 'REDEEMING' }, { status: 'ISSUED' });
    }

    const walletCode = farmerWalletAccountCode(voucher.farmerId);
    await this.ledger.ensureAccount({ code: walletCode, type: 'asset', ownerId: voucher.farmerId });
    const redemptionKey = `voucher-redemption:${voucher.id}`;
    let transaction = await this.transactions.findByIdempotencyKey(redemptionKey);
    if (!transaction) {
      const txId = newId('agtx');
      try {
        const entry = await this.ledger.postEntry(
          {
            idempotencyKey: redemptionKey,
            referenceType: 'agent_banking_voucher_redemption',
            referenceId: txId,
            description: `Offline voucher ${voucher.id} redeemed for farmer ${voucher.farmerId}`,
            postings: [
              { accountCode: walletCode, direction: 'debit', amountKobo: voucher.amountKobo },
              { accountCode: agent.floatAccountCode, direction: 'credit', amountKobo: voucher.amountKobo }
            ],
            requireSolventAccounts: [agent.floatAccountCode]
          },
          actor.id
        );
        const commissionKobo = await this.accrueCommission(
          agent,
          'voucher_redemption',
          voucher.amountKobo,
          redemptionKey,
          txId,
          actor.id
        );
        transaction = await this.transactions.create({
          id: txId,
          agentId: agent.id,
          farmerId: voucher.farmerId,
          type: 'voucher_redemption',
          amountKobo: voucher.amountKobo,
          commissionKobo,
          idempotencyKey: redemptionKey,
          ledgerEntryId: entry.id,
          voucherId: voucher.id,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        if (error instanceof ConflictException) {
          // A twin request created the transaction row first — adopt its
          // record instead of double-settling. Bounded-retry probe (stage
          // 24, audit A1-6/A4-1): the twin's row can commit a beat AFTER
          // its ledger posting already 23505'd us.
          transaction = await this.probeTransactionRow(redemptionKey);
        }
        if (!transaction) {
          // Stage 24 (audit A1-6): roll the REDEEMING claim back to ISSUED
          // ONLY when the ledger PROVES no payout entry exists under this
          // operation's key. Rolling back while the payout posting stands
          // re-opens a PAID voucher to void — the audit trail would assert
          // "voided / never paid" while the farmer's wallet keeps the money
          // and the float debit has no compensating record. When the entry
          // exists (or the probe is inconclusive) the claim stays REDEEMING
          // for the resume path and the caller gets a 409.
          const probe = await this.probeLedgerEntry(redemptionKey);
          if (probe === 'absent') {
            await this.vouchers
              .updateExpected(id, { status: 'ISSUED' }, { status: 'REDEEMING' })
              .catch(() => undefined);
            throw error;
          }
          throw new ConflictException(
            `Voucher '${id}' redemption posting state is uncertain — the claim stays REDEEMING for a safe resume; retry the redemption`
          );
        }
      }
    }
    // Finalize: REDEEMING→REDEEMED. A twin that already finalized loses this
    // CAS and surfaces as a 409 — exactly-once payout is preserved.
    const redeemed = await this.vouchers.updateExpected(
      id,
      { status: 'REDEEMED', redeemedAt: new Date().toISOString(), ledgerEntryId: transaction.ledgerEntryId },
      { status: 'REDEEMING' }
    );
    await this.events.publish(
      'agentbank.voucher.redeemed',
      { voucherId: voucher.id, agentId: agent.id, farmerId: voucher.farmerId, amountKobo: voucher.amountKobo },
      actor.id
    );
    return { voucher: redeemed, transaction };
  }

  /**
   * Voids an ISSUED voucher (issuing agent or admin). Void deliberately
   * REFUSES any non-ISSUED state — including REDEEMING (stage 22, audit
   * C3/C2-9): a voucher whose redemption claim is held cannot be voided out
   * from under the in-flight ledger posting; the redemption either settles
   * or rolls its claim back to ISSUED, after which a void can proceed.
   */
  async voidVoucher(id: string, actor: ActorRef): Promise<AgentVoucherRecord> {
    const voucher = await this.getVoucher(id);
    const agent = await this.getAgent(voucher.agentId);
    this.assertAgentAccess(agent, actor);
    if (voucher.status !== 'ISSUED') {
      throw new ConflictException(`Only ISSUED vouchers can be voided (status is ${voucher.status})`);
    }
    // Stage 24 (audit A1-6): an ISSUED voucher may still carry a committed
    // redemption payout (a crash window or a legacy rollback left the claim
    // re-opened) — voiding on top of it would assert "voided / never paid"
    // while the farmer's wallet keeps the money and the float debit stands.
    const redemptionProbe = await this.probeLedgerEntry(`voucher-redemption:${voucher.id}`);
    if (redemptionProbe === 'found') {
      throw new ConflictException(
        `Voucher '${id}' already has a redemption payout in the ledger — it cannot be voided; a redeem retry settles it`
      );
    }
    const updated = await this.vouchers.updateExpected(id, { status: 'VOIDED' }, { status: 'ISSUED' });
    await this.events.publish('agentbank.voucher.voided', { voucherId: id }, actor.id);
    return updated;
  }

  // -------------------------------------------------- commissions & reports

  async commissionStatement(agentId: string, month: string): Promise<CommissionStatement> {
    const agent = await this.getAgent(agentId);
    const { from, to } = monthBounds(month);
    const txs = await this.transactions.find({ agentId: agent.id, from, to });
    const rows = new Map<CommissionableType, CommissionStatementRow>();
    for (const tx of txs) {
      const row = rows.get(tx.type) ?? { type: tx.type, count: 0, volumeKobo: 0, commissionKobo: 0 };
      row.count += 1;
      row.volumeKobo += tx.amountKobo;
      row.commissionKobo += tx.commissionKobo;
      rows.set(tx.type, row);
    }
    // Liability account: accrued commission is the credit balance.
    const balance = await this.ledger.balance(agent.commissionAccountCode);
    return {
      agentId: agent.id,
      month,
      rows: [...rows.values()].sort((a, b) => a.type.localeCompare(b.type)),
      totalCommissionKobo: [...rows.values()].reduce((sum, row) => sum + row.commissionKobo, 0),
      commissionPayableKobo: balance.creditsKobo - balance.debitsKobo
    };
  }

  /**
   * Daily reconciliation per agent, derived from the ledger: opening/closing
   * float replay the float account's journal entries against the day bounds;
   * volumes are read from the same entries by reference type. Exportable as
   * plain JSON (the controller returns this shape verbatim).
   */
  async reconciliation(agentId: string, date: string): Promise<AgentReconciliation> {
    const agent = await this.getAgent(agentId);
    const { from, to } = dayBounds(date);
    const entries = await this.ledger.entriesForAccount(agent.floatAccountCode);
    let openingFloatKobo = 0;
    let closingFloatKobo = 0;
    const volumeByType = { cash_in: 0, cash_out: 0, voucher_redemption: 0, float_topup: 0 };
    for (const entry of entries) {
      const delta = this.floatDelta(entry, agent.floatAccountCode);
      closingFloatKobo += entry.postedAt <= to ? delta : 0;
      openingFloatKobo += entry.postedAt < from ? delta : 0;
      if (entry.postedAt >= from && entry.postedAt <= to) {
        for (const posting of entry.postings) {
          if (posting.accountCode !== agent.floatAccountCode) continue;
          const amount = posting.amountKobo;
          switch (entry.referenceType) {
            case 'agent_banking_cash_in':
              volumeByType.cash_in += amount;
              break;
            case 'agent_banking_cash_out':
              volumeByType.cash_out += amount;
              break;
            case 'agent_banking_voucher_redemption':
              volumeByType.voucher_redemption += amount;
              break;
            case 'agent_banking_float_topup':
              volumeByType.float_topup += amount;
              break;
          }
        }
      }
    }
    const txs = await this.transactions.find({ agentId: agent.id, from, to });
    return {
      agentId: agent.id,
      date,
      openingFloatKobo,
      closingFloatKobo,
      volumeByType,
      commissionAccruedKobo: txs.reduce((sum, tx) => sum + tx.commissionKobo, 0),
      transactionCount: txs.length
    };
  }

  private floatDelta(entry: LedgerJournalEntry, accountCode: string): number {
    let delta = 0;
    for (const posting of entry.postings) {
      if (posting.accountCode !== accountCode) continue;
      delta += posting.direction === 'debit' ? posting.amountKobo : -posting.amountKobo;
    }
    return delta;
  }

  // ------------------------------------------- interop (stub/simulator only)

  /**
   * Mojaloop interop status — diagnostics only. The adapter runs in stub or
   * simulator mode; NO live Mojaloop switch flow exists (docs/agent-banking.md).
   */
  async interopStatus(): Promise<MojaloopAdapterStatus & { driver: string }> {
    if (!this.mojaloop) {
      return { driver: 'stub', configured: true, healthy: true, detail: 'No Mojaloop adapter bound.' };
    }
    return { driver: this.mojaloop.name, ...(await this.mojaloop.status()) };
  }

  /** Interop quote via the Mojaloop adapter (stub/simulator only, labelled). */
  async interopQuote(input: {
    amountNaira: number;
    payerMsisdn: string;
    payeeMsisdn: string;
    reference: string;
  }): Promise<MojaloopQuote> {
    if (!this.mojaloop) {
      throw new BadRequestException('No Mojaloop adapter bound');
    }
    if (!Number.isFinite(input.amountNaira) || input.amountNaira <= 0) {
      throw new BadRequestException('amountNaira must be a positive number');
    }
    return this.mojaloop.requestQuote(input);
  }
}
