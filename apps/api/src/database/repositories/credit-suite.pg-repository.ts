import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type {
  CreditCollateral,
  CreditGroup,
  CreditGroupMember,
  CreditGroupRole,
  CreditGuarantor,
  CreditLoanApplication,
  CreditLoanProduct,
  CreditRepayment,
  CreditSavingsAccount,
  CreditSavingsTransaction,
  CreditScoreFactors
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  mapPgError,
  num,
  PgRepositoryBase,
  ts,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  CreditCollateralCriteria,
  CreditCollateralRepository,
  CreditGroupCriteria,
  CreditGroupMemberRepository,
  CreditGroupRepository,
  CreditGuarantorCriteria,
  CreditGuarantorRepository,
  CreditLoanCriteria,
  CreditLoanRepository,
  CreditProductCriteria,
  CreditProductRepository,
  CreditRepaymentCriteria,
  CreditRepaymentRepository,
  CreditSavingsAccountCriteria,
  CreditSavingsAccountRepository,
  CreditSavingsTransactionCriteria,
  CreditSavingsTransactionRepository
} from './credit-suite.repository.js';

/**
 * Credit suite PostgreSQL repositories (Wave CREDIT) over schema `credit`
 * (migration 025_credit.sql). Self-contained row mappers keep the wave
 * additive — no edits to the shared row-mappers module.
 */

/** Maps only keys present on the (possibly partial) entity into row form. */
function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

/* ------------------------------------------------------------ products -- */

export const creditProductMapper: RowMapper<CreditLoanProduct> = {
  columns: [
    'id',
    'name',
    'min_principal_kobo',
    'max_principal_kobo',
    'interest_bps_annual',
    'term_days',
    'group_lending',
    'active',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    minPrincipalKobo: num(row.min_principal_kobo),
    maxPrincipalKobo: num(row.max_principal_kobo),
    interestBpsAnnual: num(row.interest_bps_annual),
    termDays: num(row.term_days),
    groupLending: row.group_lending as boolean,
    active: row.active as boolean,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      min_principal_kobo: 'minPrincipalKobo',
      max_principal_kobo: 'maxPrincipalKobo',
      interest_bps_annual: 'interestBpsAnnual',
      term_days: 'termDays',
      group_lending: 'groupLending',
      active: 'active',
      created_at: 'createdAt'
    })
};

export function creditProductCriteriaSql(criteria: CreditProductCriteria): WhereClause {
  return composeWhere(eq('active', criteria.active), eq('group_lending', criteria.groupLending));
}

export class PgCreditProductRepository
  extends PgRepositoryBase<CreditLoanProduct, CreditProductCriteria>
  implements CreditProductRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.loan_products',
      mapper: creditProductMapper,
      criteria: creditProductCriteriaSql
    });
  }
}

export function createPgCreditProductRepository(pool: pg.Pool): PgCreditProductRepository {
  return new PgCreditProductRepository(pool);
}

/* --------------------------------------------------------------- loans -- */

export const creditLoanMapper: RowMapper<CreditLoanApplication> = {
  columns: [
    'id',
    'applicant_user_id',
    'product_id',
    'principal_kobo',
    'status',
    'credit_score',
    'score_factors',
    'purpose',
    'group_id',
    'created_at',
    'updated_at',
    'decided_at',
    'decided_by'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    applicantUserId: row.applicant_user_id as string,
    productId: row.product_id as string,
    principalKobo: num(row.principal_kobo),
    status: row.status as CreditLoanApplication['status'],
    creditScore: row.credit_score === null ? undefined : num(row.credit_score),
    scoreFactors: (row.score_factors as CreditScoreFactors | null) ?? undefined,
    purpose: (row.purpose as string | null) ?? undefined,
    groupId: (row.group_id as string | null) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    decidedAt: row.decided_at ? ts(row.decided_at) : undefined,
    decidedBy: (row.decided_by as string | null) ?? undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      applicant_user_id: 'applicantUserId',
      product_id: 'productId',
      principal_kobo: 'principalKobo',
      status: 'status',
      credit_score: 'creditScore',
      score_factors: 'scoreFactors',
      purpose: 'purpose',
      group_id: 'groupId',
      created_at: 'createdAt',
      updated_at: 'updatedAt',
      decided_at: 'decidedAt',
      decided_by: 'decidedBy'
    })
};

export function creditLoanCriteriaSql(criteria: CreditLoanCriteria): WhereClause {
  return composeWhere(
    eq('applicant_user_id', criteria.applicantUserId),
    eq('product_id', criteria.productId),
    eq('status', criteria.status),
    eq('group_id', criteria.groupId)
  );
}

export class PgCreditLoanRepository
  extends PgRepositoryBase<CreditLoanApplication, CreditLoanCriteria>
  implements CreditLoanRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.loan_applications',
      mapper: creditLoanMapper,
      criteria: creditLoanCriteriaSql
    });
  }
}

export function createPgCreditLoanRepository(pool: pg.Pool): PgCreditLoanRepository {
  return new PgCreditLoanRepository(pool);
}

/* ----------------------------------------------------------- repayments -- */

export const creditRepaymentMapper: RowMapper<CreditRepayment> = {
  columns: [
    'id',
    'loan_id',
    'sequence',
    'due_at',
    'amount_kobo',
    'paid_at',
    'paid_amount_kobo',
    'status'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    loanId: row.loan_id as string,
    sequence: num(row.sequence),
    dueAt: ts(row.due_at),
    amountKobo: num(row.amount_kobo),
    paidAt: row.paid_at ? ts(row.paid_at) : undefined,
    paidAmountKobo: row.paid_amount_kobo === null ? undefined : num(row.paid_amount_kobo),
    status: row.status as CreditRepayment['status']
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      loan_id: 'loanId',
      sequence: 'sequence',
      due_at: 'dueAt',
      amount_kobo: 'amountKobo',
      paid_at: 'paidAt',
      paid_amount_kobo: 'paidAmountKobo',
      status: 'status'
    })
};

export function creditRepaymentCriteriaSql(criteria: CreditRepaymentCriteria): WhereClause {
  return composeWhere(eq('loan_id', criteria.loanId), eq('status', criteria.status));
}

export class PgCreditRepaymentRepository
  extends PgRepositoryBase<CreditRepayment, CreditRepaymentCriteria>
  implements CreditRepaymentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.loan_repayments',
      mapper: creditRepaymentMapper,
      criteria: creditRepaymentCriteriaSql,
      orderBy: 'loan_id, sequence'
    });
  }
}

export function createPgCreditRepaymentRepository(pool: pg.Pool): PgCreditRepaymentRepository {
  return new PgCreditRepaymentRepository(pool);
}

/* ----------------------------------------------------------- collateral -- */

export const creditCollateralMapper: RowMapper<CreditCollateral> = {
  columns: ['id', 'loan_id', 'kind', 'description', 'estimated_value_kobo', 'status'],
  fromRow: (row) => ({
    id: row.id as string,
    loanId: row.loan_id as string,
    kind: row.kind as string,
    description: row.description as string,
    estimatedValueKobo: num(row.estimated_value_kobo),
    status: row.status as CreditCollateral['status']
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      loan_id: 'loanId',
      kind: 'kind',
      description: 'description',
      estimated_value_kobo: 'estimatedValueKobo',
      status: 'status'
    })
};

export function creditCollateralCriteriaSql(criteria: CreditCollateralCriteria): WhereClause {
  return composeWhere(eq('loan_id', criteria.loanId), eq('status', criteria.status));
}

export class PgCreditCollateralRepository
  extends PgRepositoryBase<CreditCollateral, CreditCollateralCriteria>
  implements CreditCollateralRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.collateral',
      mapper: creditCollateralMapper,
      criteria: creditCollateralCriteriaSql
    });
  }
}

export function createPgCreditCollateralRepository(pool: pg.Pool): PgCreditCollateralRepository {
  return new PgCreditCollateralRepository(pool);
}

/* ----------------------------------------------------------- guarantors -- */

export const creditGuarantorMapper: RowMapper<CreditGuarantor> = {
  columns: ['id', 'loan_id', 'guarantor_user_id', 'status'],
  fromRow: (row) => ({
    id: row.id as string,
    loanId: row.loan_id as string,
    guarantorUserId: row.guarantor_user_id as string,
    status: row.status as CreditGuarantor['status']
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      loan_id: 'loanId',
      guarantor_user_id: 'guarantorUserId',
      status: 'status'
    })
};

export function creditGuarantorCriteriaSql(criteria: CreditGuarantorCriteria): WhereClause {
  return composeWhere(
    eq('loan_id', criteria.loanId),
    eq('guarantor_user_id', criteria.guarantorUserId),
    eq('status', criteria.status)
  );
}

export class PgCreditGuarantorRepository
  extends PgRepositoryBase<CreditGuarantor, CreditGuarantorCriteria>
  implements CreditGuarantorRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.guarantors',
      mapper: creditGuarantorMapper,
      criteria: creditGuarantorCriteriaSql
    });
  }
}

export function createPgCreditGuarantorRepository(pool: pg.Pool): PgCreditGuarantorRepository {
  return new PgCreditGuarantorRepository(pool);
}

/* ---------------------------------------------------------------- groups -- */

export const creditGroupMapper: RowMapper<CreditGroup> = {
  columns: ['id', 'name', 'chapter_id', 'created_by', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    chapterId: (row.chapter_id as string | null) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      chapter_id: 'chapterId',
      created_by: 'createdBy',
      created_at: 'createdAt'
    })
};

export function creditGroupCriteriaSql(criteria: CreditGroupCriteria): WhereClause {
  return composeWhere(eq('chapter_id', criteria.chapterId), eq('created_by', criteria.createdBy));
}

export class PgCreditGroupRepository
  extends PgRepositoryBase<CreditGroup, CreditGroupCriteria>
  implements CreditGroupRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.credit_groups',
      mapper: creditGroupMapper,
      criteria: creditGroupCriteriaSql
    });
  }
}

export function createPgCreditGroupRepository(pool: pg.Pool): PgCreditGroupRepository {
  return new PgCreditGroupRepository(pool);
}

function memberFromRow(row: Record<string, unknown>): CreditGroupMember {
  return {
    groupId: row.group_id as string,
    userId: row.user_id as string,
    role: row.role as CreditGroupRole,
    joinedAt: ts(row.joined_at)
  };
}

/** Composite-keyed membership repository (PK group_id + user_id). */
export class PgCreditGroupMemberRepository implements CreditGroupMemberRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listByGroup(groupId: string): Promise<CreditGroupMember[]> {
    const result = await this.pool.query(
      `SELECT group_id, user_id, role, joined_at FROM credit.credit_group_members
       WHERE group_id = $1 ORDER BY joined_at, user_id`,
      [groupId]
    );
    return result.rows.map(memberFromRow);
  }

  async listByUser(userId: string): Promise<CreditGroupMember[]> {
    const result = await this.pool.query(
      `SELECT group_id, user_id, role, joined_at FROM credit.credit_group_members
       WHERE user_id = $1 ORDER BY joined_at, group_id`,
      [userId]
    );
    return result.rows.map(memberFromRow);
  }

  async find(groupId: string, userId: string): Promise<CreditGroupMember | undefined> {
    const result = await this.pool.query(
      `SELECT group_id, user_id, role, joined_at FROM credit.credit_group_members
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    return result.rows[0] ? memberFromRow(result.rows[0]) : undefined;
  }

  async add(member: CreditGroupMember): Promise<CreditGroupMember> {
    await this.pool.query(
      `INSERT INTO credit.credit_group_members (group_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [member.groupId, member.userId, member.role, member.joinedAt]
    );
    return member;
  }

  async updateRole(
    groupId: string,
    userId: string,
    role: CreditGroupRole
  ): Promise<CreditGroupMember> {
    const result = await this.pool.query(
      `UPDATE credit.credit_group_members SET role = $3
       WHERE group_id = $1 AND user_id = $2
       RETURNING group_id, user_id, role, joined_at`,
      [groupId, userId, role]
    );
    if (!result.rows[0]) {
      throw new Error(`Membership '${groupId}:${userId}' not found`);
    }
    return memberFromRow(result.rows[0]);
  }

  async remove(groupId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM credit.credit_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countByGroup(groupId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS count FROM credit.credit_group_members WHERE group_id = $1`,
      [groupId]
    );
    return num(result.rows[0]?.count ?? 0);
  }
}

export function createPgCreditGroupMemberRepository(pool: pg.Pool): PgCreditGroupMemberRepository {
  return new PgCreditGroupMemberRepository(pool);
}

/* --------------------------------------------------------------- savings -- */

export const creditSavingsAccountMapper: RowMapper<CreditSavingsAccount> = {
  columns: ['id', 'user_id', 'group_id', 'balance_kobo', 'updated_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: (row.user_id as string | null) ?? undefined,
    groupId: (row.group_id as string | null) ?? undefined,
    balanceKobo: num(row.balance_kobo),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      group_id: 'groupId',
      balance_kobo: 'balanceKobo',
      updated_at: 'updatedAt'
    })
};

export function creditSavingsAccountCriteriaSql(
  criteria: CreditSavingsAccountCriteria
): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('group_id', criteria.groupId));
}

export class PgCreditSavingsAccountRepository
  extends PgRepositoryBase<CreditSavingsAccount, CreditSavingsAccountCriteria>
  implements CreditSavingsAccountRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.savings_accounts',
      mapper: creditSavingsAccountMapper,
      criteria: creditSavingsAccountCriteriaSql
    });
  }

  /**
   * Balance CAS + transaction append (+ optional outbox event) in ONE
   * database transaction — the savings dual-write window is closed the same
   * way the funds-integrity wave closed it for escrow.
   */
  async applyTransaction(
    accountId: string,
    expected: { balanceKobo: number },
    patch: { balanceKobo: number; updatedAt: string },
    transaction: CreditSavingsTransaction,
    outboxEvent?: DomainEvent
  ): Promise<{ account: CreditSavingsAccount; transaction: CreditSavingsTransaction }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE credit.savings_accounts
         SET balance_kobo = $2, updated_at = $3
         WHERE id = $1 AND balance_kobo = $4
         RETURNING id, user_id, group_id, balance_kobo, updated_at`,
        [accountId, patch.balanceKobo, patch.updatedAt, expected.balanceKobo]
      );
      if (!updated.rows[0]) {
        const exists = await client.query(
          `SELECT id FROM credit.savings_accounts WHERE id = $1`,
          [accountId]
        );
        if (!exists.rows[0]) {
          throw new NotFoundException(`Resource with id '${accountId}' not found`);
        }
        throw new ConflictException(
          `Concurrent balance change on '${accountId}'; retry the operation`
        );
      }
      await client.query(
        `INSERT INTO credit.savings_transactions
           (id, account_id, direction, amount_kobo, balance_after_kobo, ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          transaction.id,
          transaction.accountId,
          transaction.direction,
          transaction.amountKobo,
          transaction.balanceAfterKobo,
          transaction.ref,
          transaction.createdAt
        ]
      );
      if (outboxEvent) {
        await client.query(
          `INSERT INTO events.outbox (id, name, payload, actor_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            outboxEvent.id,
            outboxEvent.name,
            JSON.stringify(outboxEvent.payload),
            outboxEvent.actorId ?? null,
            outboxEvent.occurredAt
          ]
        );
      }
      await client.query('COMMIT');
      return {
        account: creditSavingsAccountMapper.fromRow(updated.rows[0]),
        transaction
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      mapPgError(error);
    } finally {
      client.release();
    }
  }
}

export function createPgCreditSavingsAccountRepository(
  pool: pg.Pool
): PgCreditSavingsAccountRepository {
  return new PgCreditSavingsAccountRepository(pool);
}

export const creditSavingsTransactionMapper: RowMapper<CreditSavingsTransaction> = {
  columns: ['id', 'account_id', 'direction', 'amount_kobo', 'balance_after_kobo', 'ref', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    accountId: row.account_id as string,
    direction: row.direction as CreditSavingsTransaction['direction'],
    amountKobo: num(row.amount_kobo),
    balanceAfterKobo: num(row.balance_after_kobo),
    ref: row.ref as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      account_id: 'accountId',
      direction: 'direction',
      amount_kobo: 'amountKobo',
      balance_after_kobo: 'balanceAfterKobo',
      ref: 'ref',
      created_at: 'createdAt'
    })
};

export function creditSavingsTransactionCriteriaSql(
  criteria: CreditSavingsTransactionCriteria
): WhereClause {
  return composeWhere(eq('account_id', criteria.accountId), eq('ref', criteria.ref));
}

export class PgCreditSavingsTransactionRepository
  extends PgRepositoryBase<CreditSavingsTransaction, CreditSavingsTransactionCriteria>
  implements CreditSavingsTransactionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'credit.savings_transactions',
      mapper: creditSavingsTransactionMapper,
      criteria: creditSavingsTransactionCriteriaSql
    });
  }
}

export function createPgCreditSavingsTransactionRepository(
  pool: pg.Pool
): PgCreditSavingsTransactionRepository {
  return new PgCreditSavingsTransactionRepository(pool);
}
