import type { InstallmentStatus, LoanApplication, LoanStatus, RepaymentInstallment } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface LoanCriteria {
  applicantId?: string;
  lenderId?: string;
  status?: LoanStatus;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LoanApplicationRepository
  extends AsyncRepository<LoanApplication, LoanCriteria> {}

export function loanMatcher(criteria: LoanCriteria): (loan: LoanApplication) => boolean {
  return (loan) =>
    (!criteria.applicantId || loan.applicantId === criteria.applicantId) &&
    (!criteria.lenderId || loan.lenderId === criteria.lenderId) &&
    (!criteria.status || loan.status === criteria.status);
}

export class InMemoryLoanApplicationRepository
  extends InMemoryRepository<LoanApplication, LoanCriteria>
  implements LoanApplicationRepository
{
  constructor(seed: readonly LoanApplication[] = []) {
    super(seed, loanMatcher);
  }
}

export interface InstallmentCriteria {
  loanId?: string;
  status?: InstallmentStatus;
}

export interface RepaymentScheduleRepository
  extends AsyncRepository<RepaymentInstallment, InstallmentCriteria> {
  /** Replaces a loan's schedule as one atomic unit (used at disbursement). */
  replaceSchedule(loanId: string, installments: RepaymentInstallment[]): Promise<RepaymentInstallment[]>;
}

export function installmentMatcher(
  criteria: InstallmentCriteria
): (installment: RepaymentInstallment) => boolean {
  return (installment) =>
    (!criteria.loanId || installment.loanId === criteria.loanId) &&
    (!criteria.status || installment.status === criteria.status);
}

export class InMemoryRepaymentScheduleRepository
  extends InMemoryRepository<RepaymentInstallment, InstallmentCriteria>
  implements RepaymentScheduleRepository
{
  constructor(seed: readonly RepaymentInstallment[] = []) {
    super(seed, installmentMatcher);
  }

  async replaceSchedule(
    loanId: string,
    installments: RepaymentInstallment[]
  ): Promise<RepaymentInstallment[]> {
    for (const existing of await this.find({ loanId })) {
      await this.remove(existing.id);
    }
    for (const installment of installments) {
      await this.create(installment);
    }
    return installments;
  }
}

export function createInMemoryLoanApplicationRepository(): InMemoryLoanApplicationRepository {
  return new InMemoryLoanApplicationRepository();
}

export function createInMemoryRepaymentScheduleRepository(): InMemoryRepaymentScheduleRepository {
  return new InMemoryRepaymentScheduleRepository();
}
