import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { InMemoryDocumentRepository } from '../../database/repositories/document.repository.js';
import { createInMemoryCreditScoreRepository } from '../../database/repositories/credit-score.repository.js';
import { InMemoryEnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import { InMemoryCourseRepository } from '../../database/repositories/course.repository.js';
import { InMemoryCertificateRepository } from '../../database/repositories/certificate.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryLenderRepository } from '../../database/repositories/lender.repository.js';
import {
  InMemoryLoanApplicationRepository,
  InMemoryRepaymentScheduleRepository
} from '../../database/repositories/loan.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { LearningService } from '../learning/learning.service.js';
import { UsersService } from '../users/users.service.js';
import { CreditService } from './credit.service.js';
import { LedgerService } from './ledger.service.js';
import { LoanService } from './loan.service.js';

const applicant: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const credit = new CreditService(
    events,
    new UsersService(createInMemoryUserRepository()),
    new LearningService(events, new InMemoryCourseRepository(), new InMemoryEnrolmentRepository(), new InMemoryCertificateRepository()),
    createInMemoryCreditScoreRepository(),
    new InMemoryOrderRepository(),
    new InMemoryDocumentRepository(),
    new InMemoryLoanApplicationRepository(),
    new InMemoryRepaymentScheduleRepository()
  );
  const loans = new InMemoryLoanApplicationRepository();
  const schedules = new InMemoryRepaymentScheduleRepository();
  const service = new LoanService(
    events,
    ledger,
    credit,
    createInMemoryLenderRepository(),
    loans,
    schedules
  );
  return { service, ledger, events };
}

async function approvedLoan(service: LoanService) {
  const loan = await service.apply({
    applicantId: applicant.id,
    lenderId: 'lender-nyfn-coop',
    amountKobo: 12_000_000, // ₦120,000
    termMonths: 6,
    annualRateBps: 1200,
    purpose: 'Seed and fertiliser'
  });
  await service.transition(loan.id, 'submitted', applicant);
  await service.transition(loan.id, 'under_review', admin);
  await service.transition(loan.id, 'approved', admin);
  return service.getLoan(loan.id);
}

describe('LoanService', () => {
  it('validates the ticket range and integer kobo amounts at application', async () => {
    const { service } = makeService();
    await expect(
      service.apply({ applicantId: applicant.id, lenderId: 'lender-nyfn-coop', amountKobo: 100, termMonths: 6, annualRateBps: 0 })
    ).rejects.toThrowError(/ticket range/);
    await expect(
      service.apply({ applicantId: applicant.id, lenderId: 'lender-nyfn-coop', amountKobo: 10.5, termMonths: 6, annualRateBps: 0 })
    ).rejects.toThrowError(/positive integer kobo/);
    const loan = await service.apply({
      applicantId: applicant.id,
      lenderId: 'lender-nyfn-coop',
      amountKobo: 5_000_000,
      termMonths: 3,
      annualRateBps: 0
    });
    expect(loan.status).toBe('draft');
    expect(loan.productName).toBe('Input financing (per season)');
  });

  it('walks the workflow and rejects illegal transitions', async () => {
    const { service } = makeService();
    const loan = await approvedLoan(service);
    expect(loan.status).toBe('approved');
    await expect(service.transition(loan.id, 'submitted', admin)).rejects.toThrowError(
      /Invalid loan transition/
    );
    // Disbursement/closure are system-driven, not generic transitions.
    await expect(service.transition(loan.id, 'disbursed', admin)).rejects.toThrowError(
      /system-driven/
    );
    await expect(service.transition(loan.id, 'closed', admin)).rejects.toThrowError(/system-driven/);
  });

  it('enforces applicant vs reviewer scoping', async () => {
    const { service } = makeService();
    const loan = await service.apply({
      applicantId: applicant.id,
      lenderId: 'lender-nyfn-coop',
      amountKobo: 5_000_000,
      termMonths: 3,
      annualRateBps: 0
    });
    await expect(service.transition(loan.id, 'submitted', outsider)).rejects.toThrowError(
      ForbiddenException
    );
    await service.transition(loan.id, 'submitted', applicant);
    // Review actions are reviewer-only.
    await expect(service.transition(loan.id, 'under_review', applicant)).rejects.toThrowError(
      ForbiddenException
    );
    await service.transition(loan.id, 'under_review', admin);
    await expect(service.transition(loan.id, 'approved', applicant)).rejects.toThrowError(
      ForbiddenException
    );
    expect((await service.transition(loan.id, 'declined', admin)).status).toBe('declined');
    // Terminal.
    await expect(service.transition(loan.id, 'submitted', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('disburses with a balanced ledger posting and a repayment calendar', async () => {
    const { service, ledger } = makeService();
    const loan = await approvedLoan(service);
    const disbursed = await service.disburse(loan.id, admin.id, '2026-09-01');
    expect(disbursed.status).toBe('repaying');
    expect(disbursed.disbursedAt).toBeDefined();

    // Ledger: receivable debited, platform cash credited (balanced by invariant).
    const entry = (await ledger.listEntries({ referenceType: 'loan_application', referenceId: loan.id }))[0];
    expect(entry.postings).toEqual([
      { accountCode: 'member:user-adamu:loans_receivable', direction: 'debit', amountKobo: 12_000_000 },
      { accountCode: 'platform:cash', direction: 'credit', amountKobo: 12_000_000 }
    ]);
    expect((await ledger.balance('member:user-adamu:loans_receivable')).balanceKobo).toBe(12_000_000);

    // Calendar: 6 equal-installment rows, integer kobo, principal sums exactly.
    const schedule = await service.scheduleForLoan(loan.id);
    expect(schedule).toHaveLength(6);
    expect(schedule[0].dueDate).toBe('2026-09-01');
    expect(schedule.reduce((sum, i) => sum + i.principalKobo, 0)).toBe(12_000_000);
    for (const installment of schedule) {
      expect(Number.isInteger(installment.totalKobo)).toBe(true);
      expect(installment.status).toBe('pending');
    }
    // Idempotent disbursement replay.
    expect((await service.disburse(loan.id, admin.id)).id).toBe(loan.id);
    expect(await service.scheduleForLoan(loan.id)).toHaveLength(6);
  });

  it('rejects disbursement before approval', async () => {
    const { service } = makeService();
    const loan = await service.apply({
      applicantId: applicant.id,
      lenderId: 'lender-nyfn-coop',
      amountKobo: 5_000_000,
      termMonths: 3,
      annualRateBps: 0
    });
    await expect(service.disburse(loan.id, admin.id)).rejects.toThrowError(/approved/);
  });

  it('marks installments paid with balanced postings and closes the loan', async () => {
    const { service, ledger } = makeService();
    const loan = await approvedLoan(service);
    await service.disburse(loan.id, admin.id, '2026-09-01');
    const schedule = await service.scheduleForLoan(loan.id);

    for (const installment of schedule) {
      const paid = await service.markInstallmentPaid(loan.id, installment.sequence, applicant.id);
      expect(paid.status).toBe('paid');
      // Idempotent replay.
      expect((await service.markInstallmentPaid(loan.id, installment.sequence, applicant.id)).paidAt).toBe(
        paid.paidAt
      );
    }
    expect((await service.getLoan(loan.id)).status).toBe('closed');

    // Every repayment entry is balanced; receivable is fully credited back.
    const entries = await ledger.listEntries({ referenceType: 'loan_application', referenceId: loan.id });
    expect(entries).toHaveLength(1 + schedule.length);
    for (const entry of entries) {
      const debits = entry.postings.filter((p) => p.direction === 'debit').reduce((s, p) => s + p.amountKobo, 0);
      const credits = entry.postings.filter((p) => p.direction === 'credit').reduce((s, p) => s + p.amountKobo, 0);
      expect(debits).toBe(credits);
    }
    expect((await ledger.balance('member:user-adamu:loans_receivable')).balanceKobo).toBe(0);
    const interestTotal = schedule.reduce((sum, i) => sum + i.interestKobo, 0);
    expect((await ledger.balance('platform:interest_income')).creditsKobo).toBe(interestTotal);
  });

  it('rejects repayment on loans that are not repaying', async () => {
    const { service } = makeService();
    const loan = await approvedLoan(service);
    await expect(service.markInstallmentPaid(loan.id, 1, applicant.id)).rejects.toThrowError(
      /not repaying/
    );
  });

  it('ranks the lender directory against the versioned credit score', async () => {
    const { service } = makeService();
    // user-adamu has no signals in this fixture: score 10 → no eligibility.
    const matches = await service.matchLenders(applicant.id);
    expect(matches).toHaveLength(3);
    expect(matches.every((match) => !match.eligible)).toBe(true);
    expect(matches[0].reason).toContain('Requires credit score');
    // Deterministic ordering by match score (highest first).
    expect(matches[0].lender.minScore).toBe(40);
    expect(matches[2].lender.minScore).toBe(75);
  });
});
