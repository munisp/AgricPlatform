import type pg from 'pg';
import type { Lender, LoanApplication, RepaymentInstallment } from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { installmentMapper, lenderMapper, loanApplicationMapper } from '../pg/row-mappers.js';
import type { LenderCriteria, LenderRepository } from './lender.repository.js';
import type {
  InstallmentCriteria,
  LoanApplicationRepository,
  LoanCriteria,
  RepaymentScheduleRepository
} from './loan.repository.js';

/** Wave P2a credit pg repositories (lenders, loan applications, schedules). */
export function lenderCriteriaSql(criteria: LenderCriteria): WhereClause {
  return composeWhere(
    criteria.active === undefined ? null : eq('is_active', criteria.active)
  );
}

export class PgLenderRepository
  extends PgRepositoryBase<Lender, LenderCriteria>
  implements LenderRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'finance.lenders', mapper: lenderMapper, criteria: lenderCriteriaSql });
  }
}

export function loanCriteriaSql(criteria: LoanCriteria): WhereClause {
  return composeWhere(
    eq('applicant_id', criteria.applicantId),
    eq('lender_id', criteria.lenderId),
    eq('status', criteria.status)
  );
}

export class PgLoanApplicationRepository
  extends PgRepositoryBase<LoanApplication, LoanCriteria>
  implements LoanApplicationRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'finance.loan_applications',
      mapper: loanApplicationMapper,
      criteria: loanCriteriaSql
    });
  }
}

export function installmentCriteriaSql(criteria: InstallmentCriteria): WhereClause {
  return composeWhere(eq('loan_id', criteria.loanId), eq('status', criteria.status));
}

export class PgRepaymentScheduleRepository
  extends PgRepositoryBase<RepaymentInstallment, InstallmentCriteria>
  implements RepaymentScheduleRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'finance.repayment_installments',
      mapper: installmentMapper,
      criteria: installmentCriteriaSql,
      orderBy: 'loan_id, sequence'
    });
  }

  /** Schedule replacement as one transaction (disbursement regeneration). */
  async replaceSchedule(
    loanId: string,
    installments: RepaymentInstallment[]
  ): Promise<RepaymentInstallment[]> {
    return this.withTransaction(async (client) => {
      await client.query(`DELETE FROM finance.repayment_installments WHERE loan_id = $1`, [loanId]);
      for (const installment of installments) {
        const row = installmentMapper.toRow(installment);
        const columns = Object.keys(row);
        await client.query(
          `INSERT INTO finance.repayment_installments (${columns.join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          columns.map((column) => row[column])
        );
      }
      return installments;
    });
  }
}

export function createPgLenderRepository(pool: pg.Pool): PgLenderRepository {
  return new PgLenderRepository(pool);
}

export function createPgLoanApplicationRepository(pool: pg.Pool): PgLoanApplicationRepository {
  return new PgLoanApplicationRepository(pool);
}

export function createPgRepaymentScheduleRepository(pool: pg.Pool): PgRepaymentScheduleRepository {
  return new PgRepaymentScheduleRepository(pool);
}
