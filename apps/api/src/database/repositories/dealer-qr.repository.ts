import { ConflictException } from '@nestjs/common';
import type { DomainEvent } from '../../core/domain-events.service.js';

/**
 * Dealer QR Pay persistence ports (Stage 27, Innovation 16). Rows map to
 * migration 075 (agent_banking.merchant_qr_codes / merchant_payments).
 * These tables hold OPERATIONAL records only — every value movement posts
 * through the double-entry ledger (finance module) and is cross-referenced
 * by `ledgerEntryId`.
 *
 * Idempotency doctrine mirrored in both implementations:
 *   - MerchantPaymentRepository.create throws ConflictException when the
 *     idempotency key OR the Mojaloop transfer id already exists (pg:
 *     partial UNIQUE on idempotency_key + UNIQUE on mojaloop_transfer_id),
 *     so a transport retry or a redelivered switch confirmation can never
 *     duplicate a money-bearing row.
 *   - updateExpected is a compare-and-set; a lost race surfaces as 409.
 *     The pg implementation accepts an optional outbox event and commits it
 *     in the SAME transaction as the state change (transactionalOutbox).
 */

export const MERCHANT_QR_STATUSES = ['active', 'revoked'] as const;
export type MerchantQrStatus = (typeof MERCHANT_QR_STATUSES)[number];

export const MERCHANT_PAYMENT_STATUSES = ['quoted', 'completed', 'failed', 'refunded'] as const;
export type MerchantPaymentStatus = (typeof MERCHANT_PAYMENT_STATUSES)[number];

export const MERCHANT_ADAPTER_BASES = ['stub', 'simulator', 'live'] as const;
export type MerchantAdapterBasis = (typeof MERCHANT_ADAPTER_BASES)[number];

export interface MerchantQrCodeRecord {
  id: string;
  /** Agent organisation id (agent_banking.agents row) — the merchant registry. */
  agentOrgId: string;
  /** Dealer's user id (owner of the agent record). */
  dealerUserId: string;
  /** HMAC-SHA256 hex over the canonical QR payload (server-side secret). */
  payloadHmac: string;
  label: string;
  status: MerchantQrStatus;
  createdAt: string;
}

export interface MerchantQrCodeCriteria {
  agentOrgId?: string;
  status?: MerchantQrStatus;
}

export interface MerchantPaymentRecord {
  id: string;
  qrId: string;
  /** Farmer (payer) user id. */
  payerUserId: string;
  /** Total payment amount, integer kobo (voucher + wallet tender). */
  amountKobo: number;
  /** Signed offline-voucher tender, integer kobo (0 when no co-pay). */
  voucherTenderKobo: number;
  /** Mojaloop wallet tender, integer kobo (0 for voucher-only payments). */
  walletTenderKobo: number;
  /** Co-pay link: the agent_banking offline voucher applied as tender. */
  voucherId?: string;
  /** HMAC fingerprint of the payer's wallet alias — never the plaintext. */
  payerAliasHmac?: string;
  /** Switch quote id once the wallet leg was quoted. */
  quoteId?: string;
  /**
   * Switch transfer id once the wallet leg was prepared — UNIQUE, the
   * settlement idempotency key. NULL for voucher-only payments and for
   * quoted rows whose transfer was never prepared.
   */
  mojaloopTransferId?: string;
  /** Which driver produced the quote/transfer (stub|simulator|live). */
  adapterBasis: MerchantAdapterBasis;
  status: MerchantPaymentStatus;
  /** Client idempotency key for POST .../qr/:code/pay (replay-safe). */
  idempotencyKey?: string;
  ledgerEntryId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MerchantPaymentCriteria {
  qrId?: string;
  payerUserId?: string;
  status?: MerchantPaymentStatus;
}

export interface MerchantQrCodeRepository {
  create(record: MerchantQrCodeRecord): Promise<MerchantQrCodeRecord>;
  findById(id: string): Promise<MerchantQrCodeRecord | undefined>;
  find(criteria: MerchantQrCodeCriteria): Promise<MerchantQrCodeRecord[]>;
  /** Compare-and-set; conflict → 409. */
  updateExpected(
    id: string,
    patch: Partial<MerchantQrCodeRecord>,
    expected: Partial<MerchantQrCodeRecord>
  ): Promise<MerchantQrCodeRecord>;
}

export interface MerchantPaymentRepository {
  /** True when updateExpected persists a passed outbox event in the same transaction. */
  readonly transactionalOutbox?: boolean;
  /**
   * Throws ConflictException when idempotencyKey or mojaloopTransferId
   * already exists (the pg partial/full UNIQUE indexes, mirrored in memory).
   */
  create(record: MerchantPaymentRecord): Promise<MerchantPaymentRecord>;
  findById(id: string): Promise<MerchantPaymentRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<MerchantPaymentRecord | undefined>;
  findByTransferId(transferId: string): Promise<MerchantPaymentRecord | undefined>;
  find(criteria: MerchantPaymentCriteria): Promise<MerchantPaymentRecord[]>;
  /**
   * Compare-and-set; conflict → 409. When `outboxEvent` is passed and the
   * implementation is transactionalOutbox-capable (pg), the state change
   * and the outbox append commit in ONE database transaction.
   */
  updateExpected(
    id: string,
    patch: Partial<MerchantPaymentRecord>,
    expected: Partial<MerchantPaymentRecord>,
    outboxEvent?: DomainEvent
  ): Promise<MerchantPaymentRecord>;
}

// ---------------------------------------------------------- in-memory ----

export class InMemoryMerchantQrCodeRepository implements MerchantQrCodeRepository {
  private readonly items = new Map<string, MerchantQrCodeRecord>();

  async create(record: MerchantQrCodeRecord): Promise<MerchantQrCodeRecord> {
    if (this.items.has(record.id)) {
      throw new ConflictException('A record with these unique values already exists');
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<MerchantQrCodeRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: MerchantQrCodeCriteria): Promise<MerchantQrCodeRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.agentOrgId || item.agentOrgId === criteria.agentOrgId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<MerchantQrCodeRecord>,
    expected: Partial<MerchantQrCodeRecord>
  ): Promise<MerchantQrCodeRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Merchant QR code '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof MerchantQrCodeRecord] !== value) {
        throw new ConflictException(`Merchant QR code '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryMerchantPaymentRepository implements MerchantPaymentRepository {
  private readonly items = new Map<string, MerchantPaymentRecord>();

  async create(record: MerchantPaymentRecord): Promise<MerchantPaymentRecord> {
    // Mirror the pg UNIQUE constraints: idempotency_key (partial) and
    // mojaloop_transfer_id — a retry that raced the original write surfaces
    // as 409 instead of duplicating a money-bearing row.
    for (const existing of this.items.values()) {
      if (record.idempotencyKey && existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
      if (record.mojaloopTransferId && existing.mojaloopTransferId === record.mojaloopTransferId) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<MerchantPaymentRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<MerchantPaymentRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async findByTransferId(transferId: string): Promise<MerchantPaymentRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.mojaloopTransferId === transferId);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: MerchantPaymentCriteria): Promise<MerchantPaymentRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.qrId || item.qrId === criteria.qrId) &&
          (!criteria.payerUserId || item.payerUserId === criteria.payerUserId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<MerchantPaymentRecord>,
    expected: Partial<MerchantPaymentRecord>
  ): Promise<MerchantPaymentRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Merchant payment '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof MerchantPaymentRecord] !== value) {
        throw new ConflictException(`Merchant payment '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export function createInMemoryMerchantQrCodeRepository(): InMemoryMerchantQrCodeRepository {
  return new InMemoryMerchantQrCodeRepository();
}

export function createInMemoryMerchantPaymentRepository(): InMemoryMerchantPaymentRepository {
  return new InMemoryMerchantPaymentRepository();
}
