import { Inject, Injectable } from '@nestjs/common';
import {
  computeCreditScore,
  CREDIT_SCORE_VERSION,
  type CreditScoreResult,
  type CreditScoreSignals
} from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CREDIT_SCORE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  LOAN_APPLICATION_REPOSITORY,
  ORDER_REPOSITORY,
  REPAYMENT_SCHEDULE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CreditScoreRepository } from '../../database/repositories/credit-score.repository.js';
import type { DocumentRepository } from '../../database/repositories/document.repository.js';
import type { LoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { RepaymentScheduleRepository } from '../../database/repositories/loan.repository.js';
import { LearningService } from '../learning/learning.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * Versioned credit scoring (wave P2a): recomputes the deterministic
 * credit-score/v1 function from live platform signals (training
 * completions, marketplace order history, loan repayment history, verified
 * documents) and persists the result to finance.credit_scores.
 */
@Injectable()
export class CreditService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly users: UsersService,
    private readonly learning: LearningService,
    @Inject(CREDIT_SCORE_REPOSITORY) private readonly scores: CreditScoreRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(LOAN_APPLICATION_REPOSITORY) private readonly loans: LoanApplicationRepository,
    @Inject(REPAYMENT_SCHEDULE_REPOSITORY) private readonly schedules: RepaymentScheduleRepository
  ) {}

  async signalsForUser(userId: string): Promise<CreditScoreSignals> {
    const [enrolments, bought, sold, documents, memberLoans] = await Promise.all([
      this.learning.enrolmentsForUser(userId),
      this.orders.find({ buyerId: userId, status: 'completed' }),
      this.orders.find({ sellerId: userId, status: 'completed' }),
      this.documents.find({ userId, status: 'verified' }),
      this.loans.find({ applicantId: userId })
    ]);
    let onTimeRepayments = 0;
    let lateRepayments = 0;
    for (const loan of memberLoans) {
      const installments = await this.schedules.find({ loanId: loan.id });
      for (const installment of installments) {
        if (installment.status !== 'paid' || !installment.paidAt) continue;
        if (installment.paidAt.slice(0, 10) <= installment.dueDate) {
          onTimeRepayments += 1;
        } else {
          lateRepayments += 1;
        }
      }
    }
    return {
      completedCourses: enrolments.filter((e) => e.status === 'completed').length,
      completedOrders: bought.length + sold.length,
      repaidLoans: memberLoans.filter((loan) => loan.status === 'closed').length,
      defaultedLoans: memberLoans.filter((loan) => loan.status === 'defaulted').length,
      onTimeRepayments,
      lateRepayments,
      verifiedDocuments: documents.length
    };
  }

  /** Recomputes and persists the member's versioned credit score. */
  async scoreForUser(userId: string): Promise<CreditScoreResult> {
    await this.users.getById(userId);
    const signals = await this.signalsForUser(userId);
    const { score, components } = computeCreditScore(signals);
    const existing = await this.scores.findByUserId(userId);
    const result: CreditScoreResult = {
      userId,
      version: CREDIT_SCORE_VERSION,
      score,
      components,
      computedAt: new Date().toISOString()
    };
    await this.scores.upsert(result);
    if (!existing || existing.score !== score) {
      await this.events.publish(
        'finance.credit_score.updated',
        { userId, version: CREDIT_SCORE_VERSION, score },
        userId
      );
    }
    return result;
  }

  async storedScore(userId: string): Promise<CreditScoreResult | undefined> {
    return this.scores.findByUserId(userId);
  }
}
