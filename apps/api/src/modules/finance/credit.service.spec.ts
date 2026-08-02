import { describe, expect, it } from 'vitest';
import { CREDIT_SCORE_VERSION, type LoanApplication } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryCreditScoreRepository } from '../../database/repositories/credit-score.repository.js';
import { InMemoryDocumentRepository } from '../../database/repositories/document.repository.js';
import { InMemoryEnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import { InMemoryCourseRepository } from '../../database/repositories/course.repository.js';
import { InMemoryCertificateRepository } from '../../database/repositories/certificate.repository.js';
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

const USER = 'user-adamu';

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const enrolments = new InMemoryEnrolmentRepository();
  const orders = new InMemoryOrderRepository();
  const documents = new InMemoryDocumentRepository();
  const loans = new InMemoryLoanApplicationRepository();
  const schedules = new InMemoryRepaymentScheduleRepository();
  const service = new CreditService(
    events,
    new UsersService(createInMemoryUserRepository()),
    new LearningService(events, new InMemoryCourseRepository(), enrolments, new InMemoryCertificateRepository()),
    createInMemoryCreditScoreRepository(),
    orders,
    documents,
    loans,
    schedules
  );
  return { service, events, enrolments, orders, documents, loans, schedules };
}

describe('CreditService', () => {
  it('computes the versioned base score for a member without signals', async () => {
    const { service } = makeService();
    const result = await service.scoreForUser(USER);
    expect(result.version).toBe(CREDIT_SCORE_VERSION);
    expect(result.score).toBe(10); // base only
    expect(result.components).toMatchObject({ base: 10, training: 0, penalties: 0 });
  });

  it('aggregates training, order and document signals deterministically', async () => {
    const { service, enrolments, orders, documents } = makeService();
    await enrolments.create({
      id: 'enr-1',
      courseId: 'course-1',
      userId: USER,
      progressPercent: 100,
      status: 'completed',
      enrolledAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-02-01T00:00:00.000Z'
    });
    await orders.create({
      id: 'order-1',
      listingId: 'listing-cassava-kaduna',
      buyerId: USER,
      sellerId: 'user-farmer-2',
      quantity: 1,
      totalNaira: 1000,
      status: 'completed',
      escrowRequired: false,
      createdAt: '2026-03-01T00:00:00.000Z'
    });
    await documents.create({
      id: 'doc-1',
      userId: USER,
      kind: 'national_id',
      fileName: 'id.pdf',
      status: 'verified',
      uploadedAt: '2026-01-01T00:00:00.000Z'
    });
    const first = await service.scoreForUser(USER);
    // base 10 + training 6 + trade 5 + documentation 5
    expect(first.score).toBe(26);
    const second = await service.scoreForUser(USER);
    expect(second.score).toBe(first.score);
    expect((await service.storedScore(USER))?.score).toBe(first.score);
  });

  it('counts repayment history and penalises defaults', async () => {
    const { service, loans, schedules } = makeService();
    const base: Omit<LoanApplication, 'id' | 'status'> = {
      applicantId: USER,
      lenderId: 'lender-nyfn-coop',
      amountKobo: 1_000_000,
      termMonths: 2,
      annualRateBps: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    await loans.create({ ...base, id: 'loan-closed', status: 'closed' });
    await loans.create({ ...base, id: 'loan-defaulted', status: 'defaulted' });
    await schedules.create({
      id: 'inst-ontime',
      loanId: 'loan-closed',
      sequence: 1,
      dueDate: '2026-02-01',
      principalKobo: 500_000,
      interestKobo: 0,
      totalKobo: 500_000,
      status: 'paid',
      paidAt: '2026-01-30T10:00:00.000Z'
    });
    await schedules.create({
      id: 'inst-late',
      loanId: 'loan-closed',
      sequence: 2,
      dueDate: '2026-03-01',
      principalKobo: 500_000,
      interestKobo: 0,
      totalKobo: 500_000,
      status: 'paid',
      paidAt: '2026-03-05T10:00:00.000Z'
    });
    const result = await service.scoreForUser(USER);
    expect(result.components.repayment_history).toBe(12 + 2); // 1 closed loan + 1 on-time
    expect(result.components.penalties).toBe(20 + 3); // 1 default + 1 late
    expect(result.score).toBe(10 + 14 - 23);
  });
});
