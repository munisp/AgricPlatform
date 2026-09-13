import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import type {
  Chapter,
  CoopScore,
  CreditRepayment,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CHAPTER_EVENT_REPOSITORY,
  CHAPTER_REPOSITORY,
  COOP_SCORE_REPOSITORY,
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  ESCROW_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  ORDER_REPOSITORY,
  PROFILE_REPOSITORY,
  VSLA_CYCLE_REPOSITORY,
  VSLA_GROUP_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_SHARE_OUT_PLAN_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type { ChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import type { CoopScoreRepository } from '../../database/repositories/coop-score.repository.js';
import type {
  CreditGroupMemberRepository,
  CreditGroupRepository,
  CreditLoanRepository,
  CreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import type {
  VslaCycleRepository,
  VslaGroupRepository,
  VslaMemberRepository,
  VslaShareOutPlanRepository,
  VslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import {
  computeCoopInputsHash,
  computeCoopScore,
  type CoopCommercialInput,
  type CoopDataInput,
  type CoopGovernanceInput,
  type CoopRepaymentInput,
  type CoopScoreInputs,
  type CoopVslaInput
} from './coop-score.js';

/** Actor driving a cooperative-score read or recompute. */
export type CoopScoreActor = Pick<User, 'id' | 'roles'>;

/** Governance observation window: meetings in the trailing 180 days. */
export const COOP_GOVERNANCE_WINDOW_DAYS = 180;

/** A member profile counts as "complete" at this completionScore (0-100). */
export const COOP_PROFILE_COMPLETE_THRESHOLD = 60;

export interface CoopScoreView extends CoopScore {
  /** Stable id of the persisted credit.coop_scores row. */
  id: string;
}

export interface CoopScoreRecomputeResult extends CoopScoreView {
  /** false when inputs were unchanged — the identical-hash append is a no-op. */
  recomputed: boolean;
}

function isReviewer(actor: CoopScoreActor): boolean {
  return actor.roles.includes('admin') || actor.roles.includes('lender');
}

const DAY_MS = 86_400_000;

/**
 * Cooperative Score orchestration (stage-27 Innovation 14, flag `coop-score`).
 *
 * Assembles the five factor inputs from read models across credit,
 * vsla-carbon, chapters and marketplace (READ-ONLY consumption — no writes
 * to those modules), computes the deterministic score via the pure
 * computeCoopScore and appends it, versioned, to credit.coop_scores
 * (migration 072). Every role sees the SAME number and the same
 * explainability payload.
 *
 * Fail-closed: each source-module read is isolated; an unreadable module
 * yields a null factor input which the pure function scores as UNAVAILABLE
 * (0 points, badge set) — never interpolated, never fabricated.
 */
@Injectable()
export class CoopScoreService {
  private readonly telemetry: TelemetryService;

  constructor(
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(CHAPTER_EVENT_REPOSITORY) private readonly chapterEvents: ChapterEventRepository,
    @Inject(CREDIT_GROUP_REPOSITORY) private readonly creditGroups: CreditGroupRepository,
    @Inject(CREDIT_GROUP_MEMBER_REPOSITORY)
    private readonly creditGroupMembers: CreditGroupMemberRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(VSLA_GROUP_REPOSITORY) private readonly vslaGroups: VslaGroupRepository,
    @Inject(VSLA_MEMBER_REPOSITORY) private readonly vslaMembers: VslaMemberRepository,
    @Inject(VSLA_CYCLE_REPOSITORY) private readonly vslaCycles: VslaCycleRepository,
    @Inject(VSLA_SHARE_OUT_REPOSITORY) private readonly vslaShareOuts: VslaShareOutRepository,
    @Inject(VSLA_SHARE_OUT_PLAN_REPOSITORY)
    private readonly vslaShareOutPlans: VslaShareOutPlanRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(COOP_SCORE_REPOSITORY) private readonly coopScores: CoopScoreRepository,
    private readonly events: DomainEventsService,
    @Optional() telemetry?: TelemetryService,
    @Optional() private readonly audit?: AuditService
  ) {
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /**
   * Authorisation: admin and lender reviewers always; the cooperative's own
   * leadership via the chapter lead (the platform's cooperative-admin
   * surface — chapters carry leadUserId, there is no separate
   * cooperative-admin role). Everyone authorised sees the same number.
   */
  private async requireViewer(cooperativeId: string, actor: CoopScoreActor): Promise<Chapter> {
    const chapter = await this.chapters.getById(cooperativeId);
    if (isReviewer(actor) || chapter.leadUserId === actor.id) {
      return chapter;
    }
    throw new ForbiddenException(
      'Only admin, lender or the cooperative lead may view a cooperative score'
    );
  }

  /**
   * Latest persisted score for a cooperative, computing + appending one on
   * first access (credit.coop_scores is the only persistence target).
   */
  async getCoopScore(cooperativeId: string, actor: CoopScoreActor): Promise<CoopScoreView> {
    await this.requireViewer(cooperativeId, actor);
    const existing = await this.coopScores.latestFor(cooperativeId);
    if (existing) {
      return existing;
    }
    const { appended: _appended, ...computed } = await this.computeAndAppend(cooperativeId, actor);
    return computed;
  }

  /**
   * On-demand recompute (admin|lender|cooperative lead). Idempotent: when
   * the assembled inputs hash matches a stored row for this cooperative,
   * NOTHING is appended and the stored row is returned with
   * recomputed=false. Safe to drive from an external scheduler on any
   * cadence.
   */
  async recompute(cooperativeId: string, actor: CoopScoreActor): Promise<CoopScoreRecomputeResult> {
    await this.requireViewer(cooperativeId, actor);
    const { appended, ...computed } = await this.computeAndAppend(cooperativeId, actor);
    return { ...computed, recomputed: appended };
  }

  /**
   * Partner-API read: identical payload to the in-app GET (same number,
   * same explainability; no PII added). Never computes on behalf of a
   * partner — a score exists only after an in-app recompute.
   */
  async getCoopScoreForPartner(cooperativeId: string): Promise<CoopScoreView> {
    await this.chapters.getById(cooperativeId);
    const existing = await this.coopScores.latestFor(cooperativeId);
    if (existing) {
      return existing;
    }
    throw new NotFoundException(
      'No cooperative score computed yet for this cooperative — request a recompute first'
    );
  }

  /* --------------------------------------------------------- internals -- */

  private async computeAndAppend(
    cooperativeId: string,
    actor: CoopScoreActor
  ): Promise<CoopScoreView & { appended: boolean }> {
    return this.telemetry.withSpan(
      'credit.coop_score.compute',
      { 'credit.coop_score.factor_count': 5 },
      async () => {
        const computedAt = new Date().toISOString();
        const inputs = await this.assembleInputs(cooperativeId, computedAt);
        const inputsHash = computeCoopInputsHash(cooperativeId, inputs);
        const result = computeCoopScore(inputs);

        const previous = await this.coopScores.latestFor(cooperativeId);
        const appended = await this.coopScores.append({
          id: newId('cscore'),
          cooperativeId,
          score: result.score,
          band: result.band,
          factors: result.factors,
          inputsHash,
          computedAt
        });
        if (!appended) {
          const identical = await this.coopScores.findByInputsHash(cooperativeId, inputsHash);
          if (!identical) {
            throw new NotFoundException(
              'Cooperative score recompute raced: identical inputs hash vanished'
            );
          }
          return { ...identical, appended: false };
        }

        this.telemetry.increment('credit.coop_scores_computed_total', 1, {
          band: result.band
        });
        this.telemetry.record('credit.coop_score_distribution', result.score, {
          band: result.band
        });

        await this.events.publish(
          'credit.coop_score.computed',
          {
            cooperativeId,
            version: appended.version,
            score: appended.score,
            band: appended.band,
            inputsHash
          },
          actor.id
        );
        if (previous && previous.band !== appended.band) {
          await this.events.publish(
            'credit.coop_score.band_changed',
            {
              cooperativeId,
              fromBand: previous.band,
              toBand: appended.band,
              score: appended.score,
              version: appended.version
            },
            actor.id
          );
        }
        await this.audit?.record({
          actorId: actor.id,
          action: 'credit.coop_score.computed',
          entityType: 'coop_scores',
          entityId: appended.id,
          metadata: {
            cooperativeId,
            version: appended.version,
            score: appended.score,
            band: appended.band
          }
        });
        return { ...appended, appended: true };
      }
    );
  }

  /**
   * Assembles the five factor inputs. Each source read is isolated: a
   * throwing (unreadable) module maps to a null input, which the pure
   * function scores as UNAVAILABLE with a bounded (zero) contribution.
   */
  async assembleInputs(cooperativeId: string, nowIso: string): Promise<CoopScoreInputs> {
    const [repayment, vsla, governance, commercial, data] = await Promise.all([
      this.guard(() => this.gatherRepayment(cooperativeId)),
      this.guard(() => this.gatherVsla(cooperativeId)),
      this.guard(() => this.gatherGovernance(cooperativeId, nowIso)),
      this.guard(() => this.gatherCommercial(cooperativeId)),
      this.guard(() => this.gatherDataCompleteness(cooperativeId))
    ]);
    return { repayment, vsla, governance, commercial, data };
  }

  private async guard<T>(gather: () => Promise<T>): Promise<T | null> {
    try {
      return await gather();
    } catch {
      return null;
    }
  }

  /** Member user ids of the cooperative (credit groups + VSLA groups linked to the chapter). */
  private async memberIds(cooperativeId: string): Promise<Set<string>> {
    const members = new Set<string>();
    const creditGroups = await this.creditGroups.find({ chapterId: cooperativeId });
    for (const group of creditGroups) {
      for (const member of await this.creditGroupMembers.listByGroup(group.id)) {
        members.add(member.userId);
      }
    }
    const vslaGroups = await this.vslaGroups.find({ chapterId: cooperativeId });
    for (const group of vslaGroups) {
      for (const member of await this.vslaMembers.find({ groupId: group.id, status: 'ACTIVE' })) {
        members.add(member.userId);
      }
    }
    return members;
  }

  private async gatherRepayment(cooperativeId: string): Promise<CoopRepaymentInput> {
    const members = await this.memberIds(cooperativeId);
    const creditGroups = await this.creditGroups.find({ chapterId: cooperativeId });
    const loans = [];
    for (const group of creditGroups) {
      loans.push(...(await this.loans.find({ groupId: group.id })));
    }
    for (const memberId of members) {
      loans.push(...(await this.loans.find({ applicantUserId: memberId })));
    }
    const seen = new Set<string>();
    const input: CoopRepaymentInput = {
      loansConsidered: 0,
      onTimeKobo: 0,
      lateKobo: 0,
      missedKobo: 0
    };
    for (const loan of loans) {
      if (seen.has(loan.id)) {
        continue;
      }
      seen.add(loan.id);
      const schedule = await this.repayments.find({ loanId: loan.id });
      if (schedule.length === 0) {
        continue;
      }
      input.loansConsidered += 1;
      for (const installment of schedule) {
        this.classifyInstallment(installment, input);
      }
    }
    return input;
  }

  private classifyInstallment(installment: CreditRepayment, input: CoopRepaymentInput): void {
    if (installment.status === 'missed') {
      input.missedKobo += installment.amountKobo;
      return;
    }
    if (!installment.paidAt) {
      // Pending obligations are undecided — excluded, never assumed.
      return;
    }
    const paidKobo = installment.paidAmountKobo ?? installment.amountKobo;
    if (installment.paidAt <= installment.dueAt) {
      input.onTimeKobo += paidKobo;
    } else {
      input.lateKobo += paidKobo;
    }
  }

  private async gatherVsla(cooperativeId: string): Promise<CoopVslaInput> {
    const input: CoopVslaInput = {
      cyclesTotal: 0,
      cyclesClosed: 0,
      shareOutsPlanned: 0,
      shareOutsPaid: 0
    };
    const groups = await this.vslaGroups.find({ chapterId: cooperativeId });
    for (const group of groups) {
      const cycles = await this.vslaCycles.find({ groupId: group.id });
      for (const cycle of cycles) {
        input.cyclesTotal += 1;
        if (cycle.status === 'CLOSED') {
          input.cyclesClosed += 1;
        }
        input.shareOutsPlanned += (await this.vslaShareOutPlans.find({ cycleId: cycle.id })).length;
        input.shareOutsPaid += (await this.vslaShareOuts.find({ cycleId: cycle.id })).length;
      }
    }
    return input;
  }

  private async gatherGovernance(
    cooperativeId: string,
    nowIso: string
  ): Promise<CoopGovernanceInput> {
    const nowMs = Date.parse(nowIso);
    const windowStartMs = nowMs - COOP_GOVERNANCE_WINDOW_DAYS * DAY_MS;
    const events = await this.chapterEvents.find({ chapterId: cooperativeId });
    const meetings = events.filter((event) => {
      const startsMs = Date.parse(event.startsAt);
      return (
        event.type === 'meeting' &&
        Number.isFinite(startsMs) &&
        startsMs <= nowMs &&
        startsMs >= windowStartMs
      );
    });
    return {
      meetingsHeld: meetings.length,
      attendanceTotal: meetings.reduce((total, event) => total + event.attendanceCount, 0),
      rsvpTotal: meetings.reduce((total, event) => total + event.rsvpCount, 0),
      windowDays: COOP_GOVERNANCE_WINDOW_DAYS
    };
  }

  private async gatherCommercial(cooperativeId: string): Promise<CoopCommercialInput> {
    const input: CoopCommercialInput = {
      escrowsReleased: 0,
      escrowsRefunded: 0,
      escrowsDisputed: 0
    };
    const members = await this.memberIds(cooperativeId);
    for (const memberId of members) {
      const sales = await this.orders.find({ sellerId: memberId });
      for (const sale of sales) {
        for (const escrow of await this.escrows.find({ orderId: sale.id })) {
          if (escrow.status === 'released') {
            input.escrowsReleased += 1;
          } else if (escrow.status === 'refunded') {
            input.escrowsRefunded += 1;
          } else if (escrow.status === 'disputed') {
            input.escrowsDisputed += 1;
          }
        }
      }
    }
    return input;
  }

  private async gatherDataCompleteness(cooperativeId: string): Promise<CoopDataInput> {
    const members = await this.memberIds(cooperativeId);
    const input: CoopDataInput = { memberCount: members.size, membersWithProfile: 0, membersWithPlot: 0 };
    for (const memberId of members) {
      const profile = await this.profiles.findByUserId(memberId);
      if (profile && profile.completionScore >= COOP_PROFILE_COMPLETE_THRESHOLD) {
        input.membersWithProfile += 1;
      }
      if ((await this.plots.find({ ownerUserId: memberId })).length > 0) {
        input.membersWithPlot += 1;
      }
    }
    return input;
  }
}
