import { ConflictException } from '@nestjs/common';

/**
 * Agent-banking persistence ports (wave AGENTBANK). Rows map to the
 * agent_banking schema (infra/postgres/032_agent_banking.sql). These tables
 * hold OPERATIONAL records only — every value movement posts through the
 * double-entry ledger (finance module) and is cross-referenced by
 * `ledgerEntryId`. State machines advance via compare-and-set
 * (`updateExpected`) so concurrent transitions surface as 409 instead of
 * silently overwriting each other, mirroring the loan disbursement path.
 */

export const AGENT_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_TOPUP_STATUSES = ['REQUESTED', 'APPROVED', 'SETTLED', 'REJECTED'] as const;
export type AgentTopUpStatus = (typeof AGENT_TOPUP_STATUSES)[number];

export const AGENT_VOUCHER_STATUSES = ['ISSUED', 'REDEEMED', 'EXPIRED', 'VOIDED'] as const;
export type AgentVoucherStatus = (typeof AGENT_VOUCHER_STATUSES)[number];

export const AGENT_TRANSACTION_TYPES = ['cash_in', 'cash_out', 'voucher_redemption'] as const;
export type AgentTransactionType = (typeof AGENT_TRANSACTION_TYPES)[number];

export interface AgentRecord {
  id: string;
  userId: string;
  /** Organisation / cooperative the agent operates under. */
  organisation: string;
  status: AgentStatus;
  /** Ledger sub-account backing the agent float (agent:<id>:float). */
  floatAccountCode: string;
  /** Ledger liability account accruing commissions (agent:<id>:commission_payable). */
  commissionAccountCode: string;
  dailyLimitKobo: number;
  lowFloatThresholdKobo: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCriteria {
  status?: AgentStatus;
  userId?: string;
}

export interface AgentFloatTopUpRecord {
  id: string;
  agentId: string;
  amountKobo: number;
  status: AgentTopUpStatus;
  requestedBy: string;
  decidedBy?: string;
  decidedAt?: string;
  settledAt?: string;
  ledgerEntryId?: string;
  rejectionReason?: string;
  createdAt: string;
}

export interface AgentTopUpCriteria {
  agentId?: string;
  status?: AgentTopUpStatus;
}

export interface AgentVoucherRecord {
  id: string;
  agentId: string;
  farmerId: string;
  amountKobo: number;
  expiresAt: string;
  nonce: string;
  /** HMAC-SHA256 hex over the canonical voucher payload (server-side secret). */
  signature: string;
  status: AgentVoucherStatus;
  redeemedAt?: string;
  ledgerEntryId?: string;
  createdAt: string;
}

export interface AgentVoucherCriteria {
  agentId?: string;
  farmerId?: string;
  status?: AgentVoucherStatus;
}

export interface AgentTransactionRecord {
  id: string;
  agentId: string;
  farmerId: string;
  type: AgentTransactionType;
  amountKobo: number;
  commissionKobo: number;
  /** UNIQUE — transport retries with the same key replay, never double-post. */
  idempotencyKey: string;
  ledgerEntryId: string;
  voucherId?: string;
  createdAt: string;
}

export interface AgentTransactionCriteria {
  agentId?: string;
  farmerId?: string;
  type?: AgentTransactionType;
  /** Inclusive ISO date/datetime bounds on createdAt. */
  from?: string;
  to?: string;
}

export interface AgentBankingAgentRepository {
  create(record: AgentRecord): Promise<AgentRecord>;
  findById(id: string): Promise<AgentRecord | undefined>;
  findByUserId(userId: string): Promise<AgentRecord | undefined>;
  find(criteria: AgentCriteria): Promise<AgentRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<AgentRecord>,
    expected: Partial<AgentRecord>
  ): Promise<AgentRecord>;
}

export interface AgentFloatTopUpRepository {
  create(record: AgentFloatTopUpRecord): Promise<AgentFloatTopUpRecord>;
  findById(id: string): Promise<AgentFloatTopUpRecord | undefined>;
  find(criteria: AgentTopUpCriteria): Promise<AgentFloatTopUpRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<AgentFloatTopUpRecord>,
    expected: Partial<AgentFloatTopUpRecord>
  ): Promise<AgentFloatTopUpRecord>;
}

export interface AgentVoucherRepository {
  create(record: AgentVoucherRecord): Promise<AgentVoucherRecord>;
  findById(id: string): Promise<AgentVoucherRecord | undefined>;
  find(criteria: AgentVoucherCriteria): Promise<AgentVoucherRecord[]>;
  /** Compare-and-set on status; throws ConflictException when it moved on. */
  updateExpected(
    id: string,
    patch: Partial<AgentVoucherRecord>,
    expected: Partial<AgentVoucherRecord>
  ): Promise<AgentVoucherRecord>;
}

export interface AgentTransactionRepository {
  /** Throws ConflictException when idempotencyKey already exists. */
  create(record: AgentTransactionRecord): Promise<AgentTransactionRecord>;
  findByIdempotencyKey(key: string): Promise<AgentTransactionRecord | undefined>;
  find(criteria: AgentTransactionCriteria): Promise<AgentTransactionRecord[]>;
}

export class InMemoryAgentBankingAgentRepository implements AgentBankingAgentRepository {
  private readonly items = new Map<string, AgentRecord>();

  async create(record: AgentRecord): Promise<AgentRecord> {
    for (const existing of this.items.values()) {
      if (existing.userId === record.userId) {
        throw new ConflictException('This user is already registered as an agent');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<AgentRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByUserId(userId: string): Promise<AgentRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.userId === userId);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: AgentCriteria): Promise<AgentRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.status || item.status === criteria.status) &&
          (!criteria.userId || item.userId === criteria.userId)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentRecord>,
    expected: Partial<AgentRecord>
  ): Promise<AgentRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Agent '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof AgentRecord] !== value) {
        throw new ConflictException(`Agent '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryAgentFloatTopUpRepository implements AgentFloatTopUpRepository {
  private readonly items = new Map<string, AgentFloatTopUpRecord>();

  async create(record: AgentFloatTopUpRecord): Promise<AgentFloatTopUpRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<AgentFloatTopUpRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: AgentTopUpCriteria): Promise<AgentFloatTopUpRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.agentId || item.agentId === criteria.agentId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentFloatTopUpRecord>,
    expected: Partial<AgentFloatTopUpRecord>
  ): Promise<AgentFloatTopUpRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Float top-up '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof AgentFloatTopUpRecord] !== value) {
        throw new ConflictException(`Float top-up '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryAgentVoucherRepository implements AgentVoucherRepository {
  private readonly items = new Map<string, AgentVoucherRecord>();

  async create(record: AgentVoucherRecord): Promise<AgentVoucherRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<AgentVoucherRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: AgentVoucherCriteria): Promise<AgentVoucherRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.agentId || item.agentId === criteria.agentId) &&
          (!criteria.farmerId || item.farmerId === criteria.farmerId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentVoucherRecord>,
    expected: Partial<AgentVoucherRecord>
  ): Promise<AgentVoucherRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof AgentVoucherRecord] !== value) {
        throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryAgentTransactionRepository implements AgentTransactionRepository {
  private readonly items = new Map<string, AgentTransactionRecord>();

  async create(record: AgentTransactionRecord): Promise<AgentTransactionRecord> {
    // Mirror the pg UNIQUE constraint on idempotency_key: a retry that raced
    // the original write surfaces as 409 instead of double-posting.
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<AgentTransactionRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: AgentTransactionCriteria): Promise<AgentTransactionRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.agentId || item.agentId === criteria.agentId) &&
          (!criteria.farmerId || item.farmerId === criteria.farmerId) &&
          (!criteria.type || item.type === criteria.type) &&
          (!criteria.from || item.createdAt >= criteria.from) &&
          (!criteria.to || item.createdAt <= criteria.to)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export function createInMemoryAgentBankingAgentRepository(): InMemoryAgentBankingAgentRepository {
  return new InMemoryAgentBankingAgentRepository();
}

export function createInMemoryAgentFloatTopUpRepository(): InMemoryAgentFloatTopUpRepository {
  return new InMemoryAgentFloatTopUpRepository();
}

export function createInMemoryAgentVoucherRepository(): InMemoryAgentVoucherRepository {
  return new InMemoryAgentVoucherRepository();
}

export function createInMemoryAgentTransactionRepository(): InMemoryAgentTransactionRepository {
  return new InMemoryAgentTransactionRepository();
}
