import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  assertSameIdempotencyPayload,
  hashIdempotencyPayload
} from '../../common/idempotency/payload-hash.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  AGENT_DEVICE_REPOSITORY,
  AGENT_FLOAT_TOPUP_REPOSITORY,
  AGENT_REVERSAL_REPOSITORY,
  AGENT_TRANSACTION_REPOSITORY,
  AGENT_VOUCHER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AgentBankingAgentRepository,
  AgentDeviceRecord,
  AgentDeviceRepository,
  AgentFloatTopUpRecord,
  AgentFloatTopUpRepository,
  AgentRecord,
  AgentReversalRecord,
  AgentReversalRepository,
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
import {
  resolveVoucherKeyRing,
  signVoucherEnvelope,
  verifyVoucherEnvelope
} from './voucher-crypto.js';
import type { HmacKeyRing } from '../../common/crypto/key-rotation.js';

/** Default per-agent daily cash-in/out limit: N250,000. */
export const DEFAULT_AGENT_DAILY_LIMIT_KOBO = 25_000_000;
/** Default low-float flag threshold: N20,000. */
export const DEFAULT_LOW_FLOAT_THRESHOLD_KOBO = 2_000_000;
/** Default voucher validity window: 72 hours. */
export const DEFAULT_VOUCHER_TTL_MS = 72 * 60 * 60 * 1000;

export const AGENT_FLOAT_ACCOUNT_PREFIX = 'agent';
export const PLATFORM_COMMISSION_EXPENSE_ACCOUNT = 'platform:commission_expense';
export const PLATFORM_CASH_ACCOUNT = 'platform:cash';

/** W2-C2 (V-40): default voucher honour-or-refund grace window after deregistration. */
export const DEFAULT_VOUCHER_GRACE_DAYS = 30;
/** W2-C2 (V-41): minimum device-token length (V-60 PIN device-token doctrine). */
export const MIN_AGENT_DEVICE_TOKEN_LENGTH = 16;

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

/** W2-C2 (V-33): per-agent liability for cash received against unredeemed paid vouchers. */
export function agentVoucherLiabilityAccountCode(agentId: string): string {
  return `agent:${agentId}:voucher_liability`;
}

/** W2-C2 (V-33): expired-paid-voucher refunds owed to farmers (agent settlement queue). */
export function agentRefundsPayableAccountCode(agentId: string): string {
  return `agent:${agentId}:refunds_payable`;
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
  /**
   * W2-C2 (V-41): presented device token. Once the agent has at least one
   * ACTIVE device binding this is REQUIRED and must hash to an ACTIVE row;
   * a token hashing to a REVOKED row (remote freeze) is rejected 401.
   */
  deviceToken?: string;
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
  /** W2-C2 (V-08): includes 'reversal' rows whose negative commission nets the accrual. */
  type: AgentTransactionType;
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

/** W2-C2 (V-33): agent settlement view — float, voucher liability, refund queue. */
export interface AgentSettlementView {
  agentId: string;
  floatBalanceKobo: number;
  /** Outstanding paid-voucher liability (issued, not yet redeemed/expired). */
  vouchersOutstandingLiabilityKobo: number;
  /** Expired paid vouchers whose cash refund is still owed to farmers. */
  refundsPayableKobo: number;
  pendingRefunds: Array<{ voucherId: string; farmerId: string; amountKobo: number }>;
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

/**
 * UTC business date for the daily cash-limit counter (YYYY-MM-DD) — the
 * same UTC-day basis the pre-WP-G2 sum-based check used, so the cap window
 * is unchanged; a new UTC day starts a fresh counter row.
 */
function currentBusinessDate(): string {
  return new Date().toISOString().slice(0, 10);
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
  /** V-26: voucher signatures are key-versioned envelopes (kid:hmac-hex). */
  private readonly voucherKeyRing: HmacKeyRing;

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
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env,
    // W2-C2 (V-08/V-41): wired by DatabaseModule; fail closed (503) when absent.
    @Optional() @Inject(AGENT_REVERSAL_REPOSITORY) private readonly reversals?: AgentReversalRepository,
    @Optional() @Inject(AGENT_DEVICE_REPOSITORY) private readonly devices?: AgentDeviceRepository
  ) {
    this.voucherKeyRing = resolveVoucherKeyRing(env);
  }

  private reversalsRepo(): AgentReversalRepository {
    if (!this.reversals) {
      throw new ServiceUnavailableException('Agent reversal persistence is not wired');
    }
    return this.reversals;
  }

  private devicesRepo(): AgentDeviceRepository {
    if (!this.devices) {
      throw new ServiceUnavailableException('Agent device-binding persistence is not wired');
    }
    return this.devices;
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
    // OB-12: all three writes (2 ledger accounts + agent row) commit
    // atomically — a single transaction on the pg driver, compensated
    // in-memory — so a failed agents insert never leaves orphaned ledger
    // accounts. Account creation keeps ensure semantics (pre-existing codes
    // are adopted, not duplicated).
    const record = await this.agents.createWithLedgerAccounts(
      {
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
      },
      [
        {
          id: randomUUID(),
          code: agentFloatAccountCode(id),
          type: 'asset',
          ownerId: input.userId,
          currency: 'NGN',
          createdAt: now
        },
        {
          id: randomUUID(),
          code: agentCommissionAccountCode(id),
          type: 'liability',
          ownerId: input.userId,
          currency: 'NGN',
          createdAt: now
        }
      ]
    );
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
      SUSPENDED: ['ACTIVE'],
      // W2-C2 (V-40): close-out is terminal; DEREGISTERING/DEREGISTERED are
      // driven exclusively by deregisterAgent(), never by setAgentStatus.
      DEREGISTERING: [],
      DEREGISTERED: []
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
    if (status === 'ACTIVE') {
      // OB-05: the 'agent' role is granted on ACTIVATION (PENDING→ACTIVE or
      // SUSPENDED→ACTIVE), not at registration — a PENDING registration alone
      // must not confer agent API access. grantRole is a no-op when the user
      // already holds the role, so re-activation replays stay idempotent.
      await this.users.grantRole(agent.userId, 'agent');
    }
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
    // Canonical payload fingerprint (WP-G11): the same key with a DIFFERENT
    // amount/agent is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH, not a silent replay.
    const payloadHash = hashIdempotencyPayload({ agentId, amountKobo: input.amountKobo });
    const replay = await this.topups.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      assertSameIdempotencyPayload(input.idempotencyKey, replay.payloadHash, payloadHash);
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
        payloadHash,
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
        // it instead of creating a second settleable row. A twin that reused
        // the key with a different payload fails closed with a 409 (WP-G11).
        const existing = await this.topups.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertSameIdempotencyPayload(input.idempotencyKey, existing.payloadHash, payloadHash);
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
    // Canonical payload fingerprint (WP-G11): the same key with a DIFFERENT
    // amount/farmer/type is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH, not a silent
    // replay. The OTP is deliberately not fingerprinted (it is a presence
    // proof, not the operation's meaning — and derived from the key in the
    // stub driver).
    const payloadHash = hashIdempotencyPayload({
      agentId,
      farmerId: input.farmerId,
      type,
      amountKobo: input.amountKobo
    });
    const replay = await this.transactions.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      assertSameIdempotencyPayload(input.idempotencyKey, replay.payloadHash, payloadHash);
      return replay; // idempotent replay of a transport retry
    }
    // V-55 crashed-saga resume (ledger-key fallback materialisation, same
    // doctrine as vsla-carbon.service.ts): if the ledger entry for this
    // client key already exists, an earlier attempt passed the OTP gate and
    // posted the money but died before writing the transaction row. Rebuild
    // the row from the AUTHORITATIVE entry — crucially WITHOUT re-verifying
    // the (possibly single-use) OTP — instead of stranding the operation.
    const priorEntry = await this.ledger.findEntryByIdempotencyKey(
      `agent-tx:${input.idempotencyKey}`
    );
    if (priorEntry) {
      return this.materialiseCrashedCashTransaction(
        type,
        agentId,
        input,
        payloadHash,
        priorEntry,
        actor
      );
    }
    const agent = await this.activeAgent(agentId);
    this.assertAgentAccess(agent, actor);
    // W2-C2 (V-41): device binding — once the agent has bound devices, a
    // bound+ACTIVE device token is mandatory; a REVOKED token (remote
    // freeze) is rejected before any money moves.
    await this.assertDeviceAllowed(agent, input.deviceToken);
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
    // being drawn down — overdraft is impossible by construction. The daily
    // cash cap (cash-in and cash-out share one cap) is enforced ATOMICALLY
    // inside the same posting transaction via dailyLimitReservation (stage
    // 27 WP-G2, audit A1-7): the counter increments only while
    // used + amount <= cap, and rolls back with the posting on any failure.
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
        requireSolventAccounts: [type === 'cash_in' ? agent.floatAccountCode : walletCode],
        dailyLimitReservation: {
          agentId: agent.id,
          businessDate: currentBusinessDate(),
          amountKobo: input.amountKobo,
          limitKobo: agent.dailyLimitKobo
        }
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
        payloadHash,
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
        // record is authoritative; return it instead of double-posting. A
        // twin that reused the key with a different payload fails closed
        // with a 409 (WP-G11); the ledger posting above replayed under the
        // same derived key, so no extra money moved.
        const existing = await this.transactions.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertSameIdempotencyPayload(input.idempotencyKey, existing.payloadHash, payloadHash);
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * V-55: rebuild the transaction row for a cash operation whose ledger
   * posting already committed (crash between postEntry and row create, or a
   * same-key retry of one). The ledger entry is the source of truth: every
   * request field is cross-checked against it (type via referenceType,
   * amount via posting amount, farmer via wallet account code, agent via
   * float account code) — a same-key twin carrying a DIFFERENT payload fails
   * closed with 409 IDEMPOTENCY_PAYLOAD_MISMATCH instead of falsifying the
   * operational record. No OTP re-verification: presence was proven by the
   * original attempt before it posted.
   */
  private async materialiseCrashedCashTransaction(
    type: 'cash_in' | 'cash_out',
    agentId: string,
    input: CashTransactionInput,
    payloadHash: string,
    entry: LedgerJournalEntry,
    actor: ActorRef
  ): Promise<AgentTransactionRecord> {
    const expectedReferenceType =
      type === 'cash_in' ? 'agent_banking_cash_in' : 'agent_banking_cash_out';
    const postedAmountKobo = entry.postings[0]?.amountKobo;
    const walletCode = farmerWalletAccountCode(input.farmerId);
    const agent = await this.activeAgent(agentId);
    this.assertAgentAccess(agent, actor);
    const touchesWallet = entry.postings.some((posting) => posting.accountCode === walletCode);
    const touchesFloat = entry.postings.some(
      (posting) => posting.accountCode === agent.floatAccountCode
    );
    if (
      entry.referenceType !== expectedReferenceType ||
      postedAmountKobo !== input.amountKobo ||
      !touchesWallet ||
      !touchesFloat
    ) {
      throw new ConflictException(
        `IDEMPOTENCY_PAYLOAD_MISMATCH: idempotency key '${input.idempotencyKey}' was already used with a different payload`
      );
    }
    // Re-run the idempotent commission accrual so the row carries the same
    // commission value the original attempt posted (replay-safe by key).
    const commissionKobo = await this.accrueCommission(
      agent,
      type,
      input.amountKobo,
      input.idempotencyKey,
      entry.referenceId ?? newId('agtx'),
      actor.id
    );
    try {
      const record = await this.transactions.create({
        id: entry.referenceId ?? newId('agtx'),
        agentId: agent.id,
        farmerId: input.farmerId,
        type,
        amountKobo: input.amountKobo,
        commissionKobo,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        ledgerEntryId: entry.id,
        otpBasis: this.otp.name,
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'agentbank.transaction.posted',
        { transactionId: record.id, agentId: agent.id, farmerId: input.farmerId, type, amountKobo: input.amountKobo },
        actor.id
      );
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        const existing = await this.transactions.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertSameIdempotencyPayload(input.idempotencyKey, existing.payloadHash, payloadHash);
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * (stage 27 WP-G2, audit A1-7) The former check-then-act daily-limit read
   * (sum today's transaction rows, compare, then post) is gone: concurrent
   * requests all observed the same pre-sum and all posted, breaching the
   * cap. The cap is now enforced by the atomic `dailyLimitReservation`
   * upsert inside the ledger posting transaction (see cashTransaction).
   */

  private async assertWithinDailyLimit(agent: AgentRecord, amountKobo: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const { from, to } = dayBounds(today);
    const todays = await this.transactions.find({ agentId: agent.id, from, to });
    // W2-C2 (V-08): reversal rows NET OUT the same-day transaction they
    // reverse (mirroring the dailyLimitCorrection applied to the atomic
    // counter on the original business date) — a reversed fake deposit must
    // not keep consuming the agent's daily cap.
    const byId = new Map(todays.map((tx) => [tx.id, tx]));
    const used = todays.reduce((sum, tx) => {
      if (tx.type === 'reversal') {
        return tx.reversalOfTransactionId && byId.has(tx.reversalOfTransactionId)
          ? sum - tx.amountKobo
          : sum;
      }
      return sum + tx.amountKobo;
    }, 0);
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
    // Canonical payload fingerprint (WP-G11): computed from the RAW input
    // (expiresAt before defaulting) so a genuine retry fingerprints
    // identically, while the same key with a different amount/farmer/expiry
    // is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH, not a silent replay.
    const payloadHash = hashIdempotencyPayload({
      agentId,
      farmerId: input.farmerId,
      amountKobo: input.amountKobo,
      expiresAt: input.expiresAt ?? null
    });
    const replay = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      assertSameIdempotencyPayload(input.idempotencyKey, replay.payloadHash, payloadHash);
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
    const signature = signVoucherEnvelope(
      { voucherId: id, agentId: agent.id, farmerId: input.farmerId, amountKobo: input.amountKobo, expiry: expiresAt, nonce },
      this.voucherKeyRing
    );
    // W2-C2 (V-33): the farmer PAID cash for this voucher — book the
    // issuance liability (DR float: cash received into the till / CR voucher
    // liability: obligation to deliver value or refund) BEFORE the row
    // exists. Entity-derived key replays on transport retry; redemption
    // settles it and expiry reclassifies it to refunds_payable.
    await this.ledger.ensureAccount({
      code: agentVoucherLiabilityAccountCode(agent.id),
      type: 'liability',
      ownerId: agent.userId
    });
    const issuanceEntry = await this.ledger.postEntry(
      {
        idempotencyKey: `agent-voucher-issuance:${input.idempotencyKey}`,
        referenceType: 'agent_banking_voucher_issuance',
        referenceId: id,
        description: `Cash received for paid voucher ${id} (${input.amountKobo} kobo issuance liability)`,
        postings: [
          { accountCode: agent.floatAccountCode, direction: 'debit', amountKobo: input.amountKobo },
          { accountCode: agentVoucherLiabilityAccountCode(agent.id), direction: 'credit', amountKobo: input.amountKobo }
        ]
      },
      actor.id
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
        payloadHash,
        issuanceLedgerEntryId: issuanceEntry.id,
        refundStatus: 'NONE',
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
        // it instead of issuing a duplicate. A twin that reused the key
        // with a different payload fails closed with a 409 (WP-G11).
        const existing = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertSameIdempotencyPayload(input.idempotencyKey, existing.payloadHash, payloadHash);
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
      // V-33: expiry of a PAID voucher books the refundable liability.
      await this.expireIssuedAgentVoucher(voucher, actor.id);
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
      !verifyVoucherEnvelope(payload, presented, this.voucherKeyRing)
    ) {
      throw new UnauthorizedException('Voucher signature verification failed');
    }
    // W2-C2 (V-40): a DEREGISTERED agent's pre-issued vouchers stay
    // redeemable during the honour-or-refund grace window.
    const agent = await this.redeemableAgent(voucher.agentId);
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
            // W2-C2 (V-40): during the DEREGISTERED grace window the float was
            // swept to zero by definition — the payout is funded by the booked
            // issuance liability (settled immediately below, restoring the
            // float) or, for legacy vouchers, recorded as a negative-float
            // receivable against the exited agent. ACTIVE-agent redemptions
            // keep the float solvency guard.
            requireSolventAccounts: agent.status === 'ACTIVE' ? [agent.floatAccountCode] : []
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
    // W2-C2 (V-33): settle the issuance liability (DR voucher_liability /
    // CR float) exactly once per voucher. Runs AFTER the payout entry on both
    // the create and resume paths — the rollback leg above only fires when
    // the payout is proven absent, i.e. before this leg ever posts.
    let settleLedgerEntryId: string | undefined;
    if (voucher.issuanceLedgerEntryId) {
      const settleEntry = await this.ledger.postEntry(
        {
          idempotencyKey: `agent-voucher-settle:${voucher.id}`,
          referenceType: 'agent_banking_voucher_liability_settle',
          referenceId: voucher.id,
          description: `Paid voucher ${voucher.id} redeemed — issuance liability settled`,
          postings: [
            { accountCode: agentVoucherLiabilityAccountCode(agent.id), direction: 'debit', amountKobo: voucher.amountKobo },
            { accountCode: agent.floatAccountCode, direction: 'credit', amountKobo: voucher.amountKobo }
          ]
        },
        actor.id
      );
      settleLedgerEntryId = settleEntry.id;
    }
    // Finalize: REDEEMING→REDEEMED. A twin that already finalized loses this
    // CAS and surfaces as a 409 — exactly-once payout is preserved.
    const redeemed = await this.vouchers.updateExpected(
      id,
      {
        status: 'REDEEMED',
        redeemedAt: new Date().toISOString(),
        ledgerEntryId: transaction.ledgerEntryId,
        ...(settleLedgerEntryId ? { settleLedgerEntryId } : {})
      },
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
    const rows = new Map<AgentTransactionType, CommissionStatementRow>();
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


  // -------------------------------------- W2-C2: voucher liability (V-33)

  /**
   * V-40 grace-aware variant of activeAgent for voucher REDEMPTION: a
   * DEREGISTERED agent's pre-issued vouchers stay redeemable until
   * voucherGraceUntil (honour window); after it, refund via V-33.
   */
  private async redeemableAgent(agentId: string): Promise<AgentRecord> {
    const agent = await this.getAgent(agentId);
    if (agent.status === 'ACTIVE') {
      return agent;
    }
    const inGrace =
      agent.status === 'DEREGISTERED' &&
      !!agent.voucherGraceUntil &&
      Date.parse(agent.voucherGraceUntil) > Date.now();
    if (!inGrace) {
      throw new BadRequestException(
        agent.status === 'DEREGISTERED'
          ? 'This agent was deregistered and the voucher grace window has closed — the voucher must be refunded'
          : `Agent must be ACTIVE to transact (status is ${agent.status})`
      );
    }
    return agent;
  }

  /**
   * V-33: expire an ISSUED voucher, booking the refundable liability when
   * the voucher was PAID (issuance liability posted at issue): the obligation
   * reclassifies agent:<id>:voucher_liability → agent:<id>:refunds_payable so
   * it surfaces in the agent settlement queue (agentSettlement).
   * Idempotent: the entry key is entity-derived (`agent-voucher-expiry-refund:<id>`).
   */
  private async expireIssuedAgentVoucher(voucher: AgentVoucherRecord, actorId: string): Promise<AgentVoucherRecord> {
    const expired = await this.vouchers.updateExpected(voucher.id, { status: 'EXPIRED' }, { status: 'ISSUED' });
    if (!voucher.issuanceLedgerEntryId) {
      return expired; // legacy (pre-101) voucher — no liability was booked
    }
    const agent = await this.getAgent(voucher.agentId);
    await this.ledger.ensureAccount({
      code: agentRefundsPayableAccountCode(agent.id),
      type: 'liability',
      ownerId: agent.userId
    });
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `agent-voucher-expiry-refund:${voucher.id}`,
        referenceType: 'agent_banking_voucher_expiry_refund',
        referenceId: voucher.id,
        description: `Paid voucher ${voucher.id} expired unredeemed — ${voucher.amountKobo} kobo refundable to farmer ${voucher.farmerId}`,
        postings: [
          { accountCode: agentVoucherLiabilityAccountCode(agent.id), direction: 'debit', amountKobo: voucher.amountKobo },
          { accountCode: agentRefundsPayableAccountCode(agent.id), direction: 'credit', amountKobo: voucher.amountKobo }
        ]
      },
      actorId
    );
    const marked = await this.vouchers.updateExpected(
      voucher.id,
      { refundStatus: 'PAYABLE', refundLedgerEntryId: entry.id },
      { status: 'EXPIRED' }
    );
    await this.events.publish(
      'agentbank.voucher.refund_due',
      { voucherId: voucher.id, agentId: agent.id, farmerId: voucher.farmerId, amountKobo: voucher.amountKobo },
      actorId
    );
    return marked;
  }

  /** Admin/owner-triggered expiry sweep step for agent vouchers (V-33). */
  async expireVoucher(id: string, actor: ActorRef): Promise<AgentVoucherRecord> {
    const voucher = await this.getVoucher(id);
    const agent = await this.getAgent(voucher.agentId);
    this.assertAgentAccess(agent, actor);
    if (voucher.status === 'EXPIRED') {
      return voucher; // idempotent replay
    }
    if (voucher.status !== 'ISSUED') {
      throw new ConflictException(`Only ISSUED vouchers can expire (status is ${voucher.status})`);
    }
    return this.expireIssuedAgentVoucher(voucher, actor.id);
  }

  /**
   * V-33: confirms the agent handed the cash back for an expired paid
   * voucher — DR refunds_payable / CR float (float solvency-guarded), CAS
   * refundStatus PAYABLE→PAID. Idempotent replay returns the PAID row.
   */
  async confirmVoucherRefund(id: string, actor: ActorRef): Promise<AgentVoucherRecord> {
    const voucher = await this.getVoucher(id);
    const agent = await this.getAgent(voucher.agentId);
    this.assertAgentAccess(agent, actor);
    if (voucher.refundStatus === 'PAID') {
      return voucher; // idempotent replay
    }
    if (voucher.status !== 'EXPIRED' || voucher.refundStatus !== 'PAYABLE') {
      throw new ConflictException(
        `Only an EXPIRED paid voucher with a PAYABLE refund can be confirmed (status ${voucher.status}, refund ${voucher.refundStatus ?? 'NONE'})`
      );
    }
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `agent-voucher-refund:${voucher.id}`,
        referenceType: 'agent_banking_voucher_refund',
        referenceId: voucher.id,
        description: `Cash refund handed back for expired paid voucher ${voucher.id}`,
        postings: [
          { accountCode: agentRefundsPayableAccountCode(agent.id), direction: 'debit', amountKobo: voucher.amountKobo },
          { accountCode: agent.floatAccountCode, direction: 'credit', amountKobo: voucher.amountKobo }
        ],
        requireSolventAccounts: [agent.floatAccountCode]
      },
      actor.id
    );
    const updated = await this.vouchers.updateExpected(
      id,
      { refundStatus: 'PAID', refundLedgerEntryId: entry.id, refundedAt: new Date().toISOString() },
      { status: 'EXPIRED' }
    );
    await this.events.publish(
      'agentbank.voucher.refunded',
      { voucherId: voucher.id, agentId: agent.id, amountKobo: voucher.amountKobo },
      actor.id
    );
    return updated;
  }

  /**
   * V-33: the agent settlement view — float, outstanding paid-voucher
   * liability, and the refundable queue (expired paid vouchers awaiting the
   * cash hand-back).
   */
  async agentSettlement(agentId: string): Promise<AgentSettlementView> {
    const agent = await this.getAgent(agentId);
    const float = await this.ledger.balance(agent.floatAccountCode);
    const liability = await this.balanceOrZero(agentVoucherLiabilityAccountCode(agent.id));
    const refundsPayable = await this.balanceOrZero(agentRefundsPayableAccountCode(agent.id));
    const vouchers = await this.vouchers.find({ agentId: agent.id });
    const pendingRefunds = vouchers
      .filter((voucher) => voucher.status === 'EXPIRED' && voucher.refundStatus === 'PAYABLE')
      .map((voucher) => ({ voucherId: voucher.id, farmerId: voucher.farmerId, amountKobo: voucher.amountKobo }));
    return {
      agentId: agent.id,
      floatBalanceKobo: float.balanceKobo,
      vouchersOutstandingLiabilityKobo: liability.creditsKobo - liability.debitsKobo,
      refundsPayableKobo: refundsPayable.creditsKobo - refundsPayable.debitsKobo,
      pendingRefunds
    };
  }

  private async balanceOrZero(accountCode: string): Promise<{ debitsKobo: number; creditsKobo: number }> {
    try {
      const balance = await this.ledger.balance(accountCode);
      return { debitsKobo: balance.debitsKobo, creditsKobo: balance.creditsKobo };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return { debitsKobo: 0, creditsKobo: 0 }; // account never provisioned (no paid vouchers yet)
      }
      throw error;
    }
  }

  // --------------------------- W2-C2: reversal instrument (V-08, maker-checker)

  /**
   * V-08 step 1 (maker): initiate a reversal/adjustment of a cash_in/cash_out
   * transaction. Nothing moves until an admin OTHER than the initiator
   * approves. Idempotent on the client key; one live reversal per transaction.
   */
  async initiateReversal(
    agentId: string,
    input: { transactionId: string; reason: string; fraudCaseId?: string; idempotencyKey: string },
    actor: ActorRef
  ): Promise<AgentReversalRecord> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required — reversal initiation must be replay-safe');
    }
    const repo = this.reversalsRepo();
    const replay = await repo.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay; // idempotent replay
    }
    const agent = await this.getAgent(agentId);
    this.assertAgentAccess(agent, actor);
    if (!input.reason?.trim()) {
      throw new BadRequestException('A reversal reason is required (audit trail)');
    }
    const tx = await this.transactions.findById(input.transactionId);
    if (!tx || tx.agentId !== agent.id) {
      throw new NotFoundException(`Transaction '${input.transactionId}' not found for agent '${agentId}'`);
    }
    if (tx.type !== 'cash_in' && tx.type !== 'cash_out') {
      throw new BadRequestException(
        `Only cash_in/cash_out transactions can be reversed (type is ${tx.type}); voucher redemptions use the voucher refund lifecycle`
      );
    }
    if (await repo.findLiveByTransaction(tx.id)) {
      throw new ConflictException(`Transaction '${tx.id}' already has a live reversal`);
    }
    try {
      const record = await repo.create({
        id: newId('rev'),
        agentId: agent.id,
        transactionId: tx.id,
        amountKobo: tx.amountKobo,
        reason: input.reason.trim(),
        fraudCaseId: input.fraudCaseId?.trim() || undefined,
        status: 'PENDING',
        initiatedBy: actor.id,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'agentbank.reversal.initiated',
        { reversalId: record.id, agentId: agent.id, transactionId: tx.id, fraudCaseId: record.fraudCaseId },
        actor.id
      );
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        const existing = await repo.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return existing; // lost a retry race — the original is authoritative
        }
      }
      throw error;
    }
  }

  /**
   * V-08 step 2 (checker): an admin who is NOT the initiator approves → the
   * EXACT INVERSE of the original entry posts (flipped directions,
   * reversesEntryId set), the daily-limit counter on the ORIGINAL business
   * date is corrected inside the same posting transaction, the accrued
   * commission is clawed back, and a type='reversal' transaction row links
   * it all (fraudCaseId carried). Every posting is entity-keyed so an
   * APPROVED reversal resumes safely after a crash. Reject is a plain CAS.
   */
  async decideReversal(
    id: string,
    decision: 'approve' | 'reject',
    actor: ActorRef
  ): Promise<AgentReversalRecord> {
    const repo = this.reversalsRepo();
    const reversal = await repo.findById(id);
    if (!reversal) {
      throw new NotFoundException(`Reversal '${id}' not found`);
    }
    if (reversal.status === 'POSTED') {
      return reversal; // idempotent replay
    }
    if (!actor.roles.includes('admin')) {
      throw new ForbiddenException('Only an admin can decide a reversal');
    }
    if (reversal.initiatedBy === actor.id) {
      throw new ForbiddenException('Maker-checker: the initiator cannot decide their own reversal');
    }
    const now = new Date().toISOString();
    if (decision === 'reject') {
      const updated = await repo.updateExpected(
        id,
        { status: 'REJECTED', decidedBy: actor.id, decidedAt: now },
        { status: 'PENDING' }
      );
      await this.events.publish('agentbank.reversal.rejected', { reversalId: id }, actor.id);
      return updated;
    }
    // Approve: claim PENDING→APPROVED (resume-safe: an APPROVED row re-enters below).
    let current = reversal;
    if (reversal.status === 'PENDING') {
      current = await repo.updateExpected(
        id,
        { status: 'APPROVED', decidedBy: actor.id, decidedAt: now },
        { status: 'PENDING' }
      );
    }
    if (current.status !== 'APPROVED') {
      throw new ConflictException(`Reversal '${id}' cannot be approved (status is ${current.status})`);
    }
    const tx = await this.transactions.findById(current.transactionId);
    if (!tx) {
      throw new NotFoundException(`Transaction '${current.transactionId}' not found`);
    }
    const agent = await this.getAgent(current.agentId);
    const original = await this.ledger.getEntry(tx.ledgerEntryId);
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `agent-tx-reversal:${current.id}`,
        referenceType: 'agent_banking_reversal',
        referenceId: current.id,
        description: `Reversal of agent transaction ${tx.id} (${current.reason})`,
        reversesEntryId: original.id,
        postings: original.postings.map((posting) => ({
          accountCode: posting.accountCode,
          direction: posting.direction === 'debit' ? ('credit' as const) : ('debit' as const),
          amountKobo: posting.amountKobo
        })),
        // Daily-limit counter correction on the ORIGINAL business date.
        dailyLimitCorrection: {
          agentId: agent.id,
          businessDate: tx.createdAt.slice(0, 10),
          amountKobo: tx.amountKobo
        }
      },
      actor.id
    );
    // Commission clawback: exact inverse of the accrual entry (idempotent).
    if (tx.commissionKobo > 0) {
      const accrual = await this.ledger.findEntryByIdempotencyKey(`agent-commission:${tx.idempotencyKey}`);
      if (accrual) {
        await this.ledger.postEntry(
          {
            idempotencyKey: `agent-commission-reversal:${current.id}`,
            referenceType: 'agent_banking_commission_reversal',
            referenceId: current.id,
            description: `Commission clawback for reversed transaction ${tx.id}`,
            reversesEntryId: accrual.id,
            postings: accrual.postings.map((posting) => ({
              accountCode: posting.accountCode,
              direction: posting.direction === 'debit' ? ('credit' as const) : ('debit' as const),
              amountKobo: posting.amountKobo
            }))
          },
          actor.id
        );
      }
    }
    let reversalTx = await this.transactions.findByIdempotencyKey(`agent-tx-reversal-tx:${current.id}`);
    if (!reversalTx) {
      reversalTx = await this.transactions.create({
        id: newId('agtx'),
        agentId: agent.id,
        farmerId: tx.farmerId,
        type: 'reversal',
        amountKobo: tx.amountKobo,
        // NEGATIVE commission so statements/reconciliation sums net out.
        commissionKobo: -tx.commissionKobo,
        idempotencyKey: `agent-tx-reversal-tx:${current.id}`,
        ledgerEntryId: entry.id,
        reversalOfTransactionId: tx.id,
        fraudCaseId: current.fraudCaseId,
        createdAt: now
      });
    }
    const posted = await repo.updateExpected(
      id,
      { status: 'POSTED', ledgerEntryId: entry.id, reversalTransactionId: reversalTx.id },
      { status: 'APPROVED' }
    );
    await this.events.publish(
      'agentbank.reversal.posted',
      {
        reversalId: id,
        agentId: agent.id,
        transactionId: tx.id,
        amountKobo: tx.amountKobo,
        ledgerEntryId: entry.id,
        fraudCaseId: current.fraudCaseId
      },
      actor.id
    );
    return posted;
  }

  async listReversals(agentId: string, actor: ActorRef): Promise<AgentReversalRecord[]> {
    const agent = await this.getAgent(agentId);
    this.assertAgentAccess(agent, actor);
    return this.reversalsRepo().findByAgent(agent.id);
  }

  // --------------------------- W2-C2: deregistration close-out (V-40)

  /**
   * V-40: ACTIVE/SUSPENDED → DEREGISTERING → DEREGISTERED close-out:
   *   1. claim CAS into DEREGISTERING (blocks cash-in/out, top-ups and new
   *      voucher issuance — activeAgent rejects non-ACTIVE);
   *   2. float sweep to ZERO with balanced legs (DR platform:cash / CR float,
   *      float solvency-guarded), entity-keyed `agent-deregister-float-sweep:<id>`;
   *   3. accrued commission settles (DR commission_payable / CR platform:cash),
   *      entity-keyed `agent-deregister-commission:<id>`;
   *   4. finalize CAS DEREGISTERED with a voucher honour-or-refund grace
   *      window (voucherGraceUntil) during which pre-issued vouchers remain
   *      redeemable (redeemableAgent); expired/unredeemed paid vouchers then
   *      surface in the settlement queue as refundable (V-33).
   * Every posting is idempotent, so a DEREGISTERING agent resumes safely.
   */
  async deregisterAgent(
    id: string,
    input: { reason?: string; voucherGraceDays?: number } = {},
    actorId: string
  ): Promise<AgentRecord> {
    const agent = await this.getAgent(id);
    if (agent.status === 'DEREGISTERED') {
      return agent; // idempotent replay
    }
    if (agent.status !== 'ACTIVE' && agent.status !== 'SUSPENDED' && agent.status !== 'DEREGISTERING') {
      throw new BadRequestException(`Only ACTIVE or SUSPENDED agents can deregister (status is ${agent.status})`);
    }
    const now = new Date().toISOString();
    if (agent.status !== 'DEREGISTERING') {
      await this.agents.updateExpected(
        id,
        { status: 'DEREGISTERING', deregistrationReason: input.reason?.trim() || undefined, updatedAt: now },
        { status: agent.status }
      );
    }
    const float = await this.ledger.balance(agent.floatAccountCode);
    if (float.balanceKobo > 0) {
      await this.ledger.ensureAccount({ code: PLATFORM_CASH_ACCOUNT, type: 'asset' });
      await this.ledger.postEntry(
        {
          idempotencyKey: `agent-deregister-float-sweep:${agent.id}`,
          referenceType: 'agent_banking_deregister',
          referenceId: agent.id,
          description: `Deregistration close-out: float sweep of ${float.balanceKobo} kobo from agent ${agent.id}`,
          postings: [
            { accountCode: PLATFORM_CASH_ACCOUNT, direction: 'debit', amountKobo: float.balanceKobo },
            { accountCode: agent.floatAccountCode, direction: 'credit', amountKobo: float.balanceKobo }
          ],
          requireSolventAccounts: [agent.floatAccountCode]
        },
        actorId
      );
    }
    const commission = await this.ledger.balance(agent.commissionAccountCode);
    const payableKobo = commission.creditsKobo - commission.debitsKobo;
    if (payableKobo > 0) {
      await this.ledger.ensureAccount({ code: PLATFORM_CASH_ACCOUNT, type: 'asset' });
      await this.ledger.postEntry(
        {
          idempotencyKey: `agent-deregister-commission:${agent.id}`,
          referenceType: 'agent_banking_deregister_commission',
          referenceId: agent.id,
          description: `Deregistration close-out: commission settlement of ${payableKobo} kobo to agent ${agent.id}`,
          postings: [
            { accountCode: agent.commissionAccountCode, direction: 'debit', amountKobo: payableKobo },
            { accountCode: PLATFORM_CASH_ACCOUNT, direction: 'credit', amountKobo: payableKobo }
          ]
        },
        actorId
      );
    }
    const graceDays = input.voucherGraceDays ?? DEFAULT_VOUCHER_GRACE_DAYS;
    const updated = await this.agents.updateExpected(
      id,
      {
        status: 'DEREGISTERED',
        deregisteredAt: now,
        voucherGraceUntil: new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: now
      },
      { status: 'DEREGISTERING' }
    );
    await this.events.publish(
      'agentbank.agent.deregistered',
      {
        agentId: agent.id,
        floatSweptKobo: Math.max(0, float.balanceKobo),
        commissionSettledKobo: Math.max(0, payableKobo),
        voucherGraceUntil: updated.voucherGraceUntil
      },
      actorId
    );
    return updated;
  }

  // --------------------------- W2-C2: device binding (V-41)

  /** V-41/V-60 hash-at-rest: only the keyed hash of a device token persists. */
  private hashDeviceToken(agentId: string, deviceToken: string): string {
    return createHash('sha256').update(`agent-device:${agentId}:${deviceToken}`).digest('hex');
  }

  /**
   * V-41: bind a device to an agent (owner or admin). Re-binding the same
   * ACTIVE device replays; a REVOKED device stays revoked (fail closed —
   * enrol a NEW token). Binding an ADDITIONAL device emits the audited
   * re-enrolment event.
   */
  async bindDevice(
    agentId: string,
    input: { deviceToken: string; label?: string },
    actor: ActorRef
  ): Promise<AgentDeviceRecord> {
    const repo = this.devicesRepo();
    const agent = await this.getAgent(agentId);
    this.assertAgentAccess(agent, actor);
    if (agent.status === 'DEREGISTERING' || agent.status === 'DEREGISTERED') {
      throw new BadRequestException('A deregistered agent cannot bind devices');
    }
    if (!input.deviceToken || input.deviceToken.length < MIN_AGENT_DEVICE_TOKEN_LENGTH) {
      throw new BadRequestException(
        `deviceToken must be at least ${MIN_AGENT_DEVICE_TOKEN_LENGTH} characters (high-entropy device identity)`
      );
    }
    const tokenHash = this.hashDeviceToken(agent.id, input.deviceToken);
    const existing = await repo.findByAgentAndHash(agent.id, tokenHash);
    if (existing) {
      if (existing.status === 'REVOKED') {
        throw new ConflictException('This device was revoked — enrol a new device token instead');
      }
      return existing; // idempotent replay of a re-bind
    }
    const boundCount = (await repo.findByAgent(agent.id)).length;
    const record = await repo.create({
      id: newId('dev'),
      agentId: agent.id,
      deviceTokenHash: tokenHash,
      label: input.label?.trim() || undefined,
      status: 'ACTIVE',
      boundBy: actor.id,
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      boundCount > 0 ? 'agentbank.agent.device_reenrolled' : 'agentbank.agent.device_bound',
      { agentId: agent.id, deviceId: record.id, boundBy: actor.id, reenrolment: boundCount > 0 },
      actor.id
    );
    return record;
  }

  /** V-41: remote freeze/revoke — ACTIVE→REVOKED CAS, audited. */
  async revokeDevice(
    agentId: string,
    deviceId: string,
    actor: ActorRef,
    reason?: string
  ): Promise<AgentDeviceRecord> {
    const repo = this.devicesRepo();
    const agent = await this.getAgent(agentId);
    this.assertAgentAccess(agent, actor);
    const device = await repo.findById(deviceId);
    if (!device || device.agentId !== agent.id) {
      throw new NotFoundException(`Device '${deviceId}' not found for agent '${agentId}'`);
    }
    if (device.status === 'REVOKED') {
      return device; // idempotent replay
    }
    const updated = await repo.updateExpected(
      deviceId,
      { status: 'REVOKED', revokedBy: actor.id, revokedAt: new Date().toISOString(), revokeReason: reason?.trim() || undefined },
      { status: 'ACTIVE' }
    );
    await this.events.publish(
      'agentbank.agent.device_revoked',
      { agentId: agent.id, deviceId, revokedBy: actor.id, reason: reason?.trim() },
      actor.id
    );
    return updated;
  }

  async listDevices(agentId: string, actor: ActorRef): Promise<AgentDeviceRecord[]> {
    const agent = await this.getAgent(agentId);
    this.assertAgentAccess(agent, actor);
    return this.devicesRepo().findByAgent(agent.id);
  }

  /**
   * V-41 cash-endpoint enforcement: legacy agents (no bindings at all) pass
   * through; once any binding exists a presented token is MANDATORY and must
   * hash to an ACTIVE row — a revoked token is rejected (remote freeze).
   */
  private async assertDeviceAllowed(agent: AgentRecord, deviceToken?: string): Promise<void> {
    if (!this.devices) {
      return; // persistence not wired (unit harnesses) — enforcement off
    }
    const bindings = await this.devices.findByAgent(agent.id);
    if (bindings.length === 0) {
      return; // legacy pass-through until the first device is bound
    }
    if (!deviceToken) {
      throw new UnauthorizedException('This agent transacts from bound devices only — present the device token');
    }
    const binding = await this.devices.findByAgentAndHash(agent.id, this.hashDeviceToken(agent.id, deviceToken));
    if (!binding) {
      throw new ForbiddenException('Unknown device — bind it first (device re-enrolment is audited)');
    }
    if (binding.status === 'REVOKED') {
      throw new UnauthorizedException('This device was revoked (remote freeze) — cash endpoints refuse it');
    }
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
