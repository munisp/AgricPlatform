import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  CreditCollateral,
  CreditCollateralStatus,
  CreditGroup,
  CreditGroupMember,
  CreditGroupRole,
  CreditGuarantor,
  CreditGuarantorStatus,
  CreditLoanApplication,
  CreditLoanProduct,
  CreditLoanStatus,
  CreditRepayment,
  CreditRepaymentStatus,
  CreditSavingsAccount,
  CreditSavingsTransaction
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import type { DomainEvent } from '../../core/domain-events.service.js';

/**
 * Credit suite repository ports (Wave CREDIT). Ports extend the async
 * repository contract so the in-memory implementations keep full fidelity
 * for unit tests while the PostgreSQL implementations compile the same
 * criteria into whitelisted WHERE fragments (schema `credit`, migration
 * 025_credit.sql).
 */

/* ------------------------------------------------------------ products -- */

export interface CreditProductCriteria {
  active?: boolean;
  groupLending?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditProductRepository
  extends AsyncRepository<CreditLoanProduct, CreditProductCriteria> {}

export function creditProductMatcher(
  criteria: CreditProductCriteria
): (product: CreditLoanProduct) => boolean {
  return (product) =>
    (criteria.active === undefined || product.active === criteria.active) &&
    (criteria.groupLending === undefined || product.groupLending === criteria.groupLending);
}

export class InMemoryCreditProductRepository
  extends InMemoryRepository<CreditLoanProduct, CreditProductCriteria>
  implements CreditProductRepository
{
  constructor(seed: readonly CreditLoanProduct[] = []) {
    super(seed, creditProductMatcher);
  }
}

export function createInMemoryCreditProductRepository(): InMemoryCreditProductRepository {
  return new InMemoryCreditProductRepository();
}

/* --------------------------------------------------------------- loans -- */

export interface CreditLoanCriteria {
  applicantUserId?: string;
  productId?: string;
  status?: CreditLoanStatus;
  groupId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditLoanRepository
  extends AsyncRepository<CreditLoanApplication, CreditLoanCriteria> {}

export function creditLoanMatcher(
  criteria: CreditLoanCriteria
): (loan: CreditLoanApplication) => boolean {
  return (loan) =>
    (!criteria.applicantUserId || loan.applicantUserId === criteria.applicantUserId) &&
    (!criteria.productId || loan.productId === criteria.productId) &&
    (!criteria.status || loan.status === criteria.status) &&
    (!criteria.groupId || loan.groupId === criteria.groupId);
}

export class InMemoryCreditLoanRepository
  extends InMemoryRepository<CreditLoanApplication, CreditLoanCriteria>
  implements CreditLoanRepository
{
  constructor(seed: readonly CreditLoanApplication[] = []) {
    super(seed, creditLoanMatcher);
  }
}

export function createInMemoryCreditLoanRepository(): InMemoryCreditLoanRepository {
  return new InMemoryCreditLoanRepository();
}

/* ----------------------------------------------------------- repayments -- */

export interface CreditRepaymentCriteria {
  loanId?: string;
  status?: CreditRepaymentStatus;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditRepaymentRepository
  extends AsyncRepository<CreditRepayment, CreditRepaymentCriteria> {}

export function creditRepaymentMatcher(
  criteria: CreditRepaymentCriteria
): (repayment: CreditRepayment) => boolean {
  return (repayment) =>
    (!criteria.loanId || repayment.loanId === criteria.loanId) &&
    (!criteria.status || repayment.status === criteria.status);
}

export class InMemoryCreditRepaymentRepository
  extends InMemoryRepository<CreditRepayment, CreditRepaymentCriteria>
  implements CreditRepaymentRepository
{
  constructor(seed: readonly CreditRepayment[] = []) {
    super(seed, creditRepaymentMatcher);
  }
}

export function createInMemoryCreditRepaymentRepository(): InMemoryCreditRepaymentRepository {
  return new InMemoryCreditRepaymentRepository();
}

/* ----------------------------------------------------------- collateral -- */

export interface CreditCollateralCriteria {
  loanId?: string;
  status?: CreditCollateralStatus;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditCollateralRepository
  extends AsyncRepository<CreditCollateral, CreditCollateralCriteria> {}

export function creditCollateralMatcher(
  criteria: CreditCollateralCriteria
): (collateral: CreditCollateral) => boolean {
  return (collateral) =>
    (!criteria.loanId || collateral.loanId === criteria.loanId) &&
    (!criteria.status || collateral.status === criteria.status);
}

export class InMemoryCreditCollateralRepository
  extends InMemoryRepository<CreditCollateral, CreditCollateralCriteria>
  implements CreditCollateralRepository
{
  constructor(seed: readonly CreditCollateral[] = []) {
    super(seed, creditCollateralMatcher);
  }
}

export function createInMemoryCreditCollateralRepository(): InMemoryCreditCollateralRepository {
  return new InMemoryCreditCollateralRepository();
}

/* ----------------------------------------------------------- guarantors -- */

export interface CreditGuarantorCriteria {
  loanId?: string;
  guarantorUserId?: string;
  status?: CreditGuarantorStatus;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditGuarantorRepository
  extends AsyncRepository<CreditGuarantor, CreditGuarantorCriteria> {}

export function creditGuarantorMatcher(
  criteria: CreditGuarantorCriteria
): (guarantor: CreditGuarantor) => boolean {
  return (guarantor) =>
    (!criteria.loanId || guarantor.loanId === criteria.loanId) &&
    (!criteria.guarantorUserId || guarantor.guarantorUserId === criteria.guarantorUserId) &&
    (!criteria.status || guarantor.status === criteria.status);
}

export class InMemoryCreditGuarantorRepository
  extends InMemoryRepository<CreditGuarantor, CreditGuarantorCriteria>
  implements CreditGuarantorRepository
{
  constructor(seed: readonly CreditGuarantor[] = []) {
    super(seed, creditGuarantorMatcher);
  }
}

export function createInMemoryCreditGuarantorRepository(): InMemoryCreditGuarantorRepository {
  return new InMemoryCreditGuarantorRepository();
}

/* ---------------------------------------------------------------- groups -- */

export interface CreditGroupCriteria {
  chapterId?: string;
  createdBy?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditGroupRepository
  extends AsyncRepository<CreditGroup, CreditGroupCriteria> {}

export function creditGroupMatcher(criteria: CreditGroupCriteria): (group: CreditGroup) => boolean {
  return (group) =>
    (!criteria.chapterId || group.chapterId === criteria.chapterId) &&
    (!criteria.createdBy || group.createdBy === criteria.createdBy);
}

export class InMemoryCreditGroupRepository
  extends InMemoryRepository<CreditGroup, CreditGroupCriteria>
  implements CreditGroupRepository
{
  constructor(seed: readonly CreditGroup[] = []) {
    super(seed, creditGroupMatcher);
  }
}

export function createInMemoryCreditGroupRepository(): InMemoryCreditGroupRepository {
  return new InMemoryCreditGroupRepository();
}

/**
 * Group membership port. Membership is keyed by the composite
 * (groupId, userId) primary key, so it does not extend the generic
 * id-keyed AsyncRepository.
 */
export interface CreditGroupMemberRepository {
  listByGroup(groupId: string): Promise<CreditGroupMember[]>;
  listByUser(userId: string): Promise<CreditGroupMember[]>;
  find(groupId: string, userId: string): Promise<CreditGroupMember | undefined>;
  add(member: CreditGroupMember): Promise<CreditGroupMember>;
  updateRole(groupId: string, userId: string, role: CreditGroupRole): Promise<CreditGroupMember>;
  remove(groupId: string, userId: string): Promise<boolean>;
  countByGroup(groupId: string): Promise<number>;
}

export class InMemoryCreditGroupMemberRepository implements CreditGroupMemberRepository {
  private readonly items = new Map<string, CreditGroupMember>();

  constructor(seed: readonly CreditGroupMember[] = []) {
    for (const member of seed) {
      this.items.set(`${member.groupId}:${member.userId}`, structuredClone(member));
    }
  }

  async listByGroup(groupId: string): Promise<CreditGroupMember[]> {
    return [...this.items.values()].filter((member) => member.groupId === groupId);
  }

  async listByUser(userId: string): Promise<CreditGroupMember[]> {
    return [...this.items.values()].filter((member) => member.userId === userId);
  }

  async find(groupId: string, userId: string): Promise<CreditGroupMember | undefined> {
    return this.items.get(`${groupId}:${userId}`);
  }

  async add(member: CreditGroupMember): Promise<CreditGroupMember> {
    this.items.set(`${member.groupId}:${member.userId}`, member);
    return member;
  }

  async updateRole(
    groupId: string,
    userId: string,
    role: CreditGroupRole
  ): Promise<CreditGroupMember> {
    const existing = this.items.get(`${groupId}:${userId}`);
    if (!existing) {
      throw new Error(`Membership '${groupId}:${userId}' not found`);
    }
    const next = { ...existing, role };
    this.items.set(`${groupId}:${userId}`, next);
    return next;
  }

  async remove(groupId: string, userId: string): Promise<boolean> {
    return this.items.delete(`${groupId}:${userId}`);
  }

  async countByGroup(groupId: string): Promise<number> {
    return (await this.listByGroup(groupId)).length;
  }
}

export function createInMemoryCreditGroupMemberRepository(): InMemoryCreditGroupMemberRepository {
  return new InMemoryCreditGroupMemberRepository();
}

/* --------------------------------------------------------------- savings -- */

export interface CreditSavingsAccountCriteria {
  userId?: string;
  groupId?: string;
}

export interface CreditSavingsAccountRepository
  extends AsyncRepository<CreditSavingsAccount, CreditSavingsAccountCriteria> {
  /**
   * Atomic savings mutation (mirrors the funds-integrity CAS+outbox
   * pattern): applies the balance change, appends the transaction row and
   * (pg) the outbox event in ONE unit of work. Throws ConflictException
   * when the expected balance no longer holds (concurrent transaction) or
   * when the transaction ref already exists (idempotent-replay race — the
   * caller re-reads by ref and returns the stored transaction).
   */
  applyTransaction(
    accountId: string,
    expected: { balanceKobo: number },
    patch: { balanceKobo: number; updatedAt: string },
    transaction: CreditSavingsTransaction,
    outboxEvent?: DomainEvent
  ): Promise<{ account: CreditSavingsAccount; transaction: CreditSavingsTransaction }>;
}

export function creditSavingsAccountMatcher(
  criteria: CreditSavingsAccountCriteria
): (account: CreditSavingsAccount) => boolean {
  return (account) =>
    (criteria.userId === undefined || account.userId === criteria.userId) &&
    (criteria.groupId === undefined || account.groupId === criteria.groupId);
}

export class InMemoryCreditSavingsAccountRepository
  extends InMemoryRepository<CreditSavingsAccount, CreditSavingsAccountCriteria>
  implements CreditSavingsAccountRepository
{
  constructor(
    seed: readonly CreditSavingsAccount[] = [],
    private readonly transactions?: InMemoryCreditSavingsTransactionRepository
  ) {
    super(seed, creditSavingsAccountMatcher);
  }

  /**
   * Synchronous check-and-set mirroring the guarded pg transaction: the
   * balance precondition, balance write and transaction append execute in
   * one synchronous tick, so concurrent mutations serialise exactly like
   * the SQL (see the funds-integrity wave). The outbox event is NOT
   * persisted here; callers fall back to DomainEventsService.persist.
   */
  async applyTransaction(
    accountId: string,
    expected: { balanceKobo: number },
    patch: { balanceKobo: number; updatedAt: string },
    transaction: CreditSavingsTransaction
  ): Promise<{ account: CreditSavingsAccount; transaction: CreditSavingsTransaction }> {
    const current = this.items.get(accountId);
    if (!current) {
      throw new NotFoundException(`Resource with id '${accountId}' not found`);
    }
    if (current.balanceKobo !== expected.balanceKobo) {
      throw new ConflictException(
        `Concurrent balance change on '${accountId}'; retry the operation`
      );
    }
    if (this.transactions?.findByRefSync(transaction.ref)) {
      throw new ConflictException(
        `A savings transaction with ref '${transaction.ref}' already exists`
      );
    }
    const account: CreditSavingsAccount = {
      ...current,
      balanceKobo: patch.balanceKobo,
      updatedAt: patch.updatedAt
    };
    this.items.set(accountId, account);
    this.transactions?.createSync(transaction);
    return { account, transaction };
  }
}

export function createInMemoryCreditSavingsAccountRepository(
  transactions?: InMemoryCreditSavingsTransactionRepository
): InMemoryCreditSavingsAccountRepository {
  return new InMemoryCreditSavingsAccountRepository([], transactions);
}

export interface CreditSavingsTransactionCriteria {
  accountId?: string;
  ref?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreditSavingsTransactionRepository
  extends AsyncRepository<CreditSavingsTransaction, CreditSavingsTransactionCriteria> {}

export function creditSavingsTransactionMatcher(
  criteria: CreditSavingsTransactionCriteria
): (transaction: CreditSavingsTransaction) => boolean {
  return (transaction) =>
    (!criteria.accountId || transaction.accountId === criteria.accountId) &&
    (!criteria.ref || transaction.ref === criteria.ref);
}

export class InMemoryCreditSavingsTransactionRepository
  extends InMemoryRepository<CreditSavingsTransaction, CreditSavingsTransactionCriteria>
  implements CreditSavingsTransactionRepository
{
  constructor(seed: readonly CreditSavingsTransaction[] = []) {
    super(seed, creditSavingsTransactionMatcher);
  }

  /** Synchronous ref lookup so guarded balance+transaction bodies stay atomic. */
  findByRefSync(ref: string): CreditSavingsTransaction | undefined {
    return [...this.items.values()].find((transaction) => transaction.ref === ref);
  }

  /** Synchronous append (mirrors create; used inside atomic CAS bodies). */
  createSync(transaction: CreditSavingsTransaction): CreditSavingsTransaction {
    this.items.set(transaction.id, transaction);
    return transaction;
  }
}

export function createInMemoryCreditSavingsTransactionRepository(): InMemoryCreditSavingsTransactionRepository {
  return new InMemoryCreditSavingsTransactionRepository();
}
