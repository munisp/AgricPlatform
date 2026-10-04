import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ChapterEvent,
  CoopScoreBand,
  CoopScoreFactor,
  CoopScoreFactorKey,
  CoopScoreRecord
} from '@agric-platform/shared';
import { computeCoopScore } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
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
import type { ChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
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

/** Actor as seen by the coop-score read/recompute endpoints. */
export interface CoopScoreActor {
  id: string;
  roles: string[];
}

const REVIEWER_ROLES = ['admin', 'lender'] as const;
const DAY_MS = 86_400_000;
const GOVERNANCE_WINDOW_DAYS = 180;

/** Roles allowed to read/recompute a cooperative's score. */
function assertReviewer(actor: CoopScoreActor, leadUserId?: string): void {
  if (REVIEWER_ROLES.some((role) => actor.roles.includes(role))) {
    return;
  }
  if (leadUserId !== undefined && actor.id === leadUserId) {
    return;
  }
  throw new ForbiddenException(
    'Cooperative scores are visible to admin, lender and the cooperative lead only'
  );
}

/**
 * Cooperative credit score (stage-27 Innovation 14): deterministic factor
 * assembly from five existing modules, append-only versioned persistence,
 * idempotent recompute (identical inputs → same version, no new event), and
 * band-change domain events. Factor math lives in @agric-platform/shared
 * (computeCoopScore); this service gathers inputs, degrades fail-closed
 * when a source module is unreadable, and persists.
 */
@Injectable()
export class CoopScoreService {
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
    @Inject(VSLA_SHARE_OUT_REPOSITORY) private readonly shareOuts: VslaShareOutRepository,
    @Inject(VSLA_SHARE_OUT_PLAN_REPOSITORY)
    private readonly shareOutPlans: VslaShareOutPlanRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(COOP_SCORE_REPOSITORY) private readonly scores: CoopScoreRepository,
    private readonly events: DomainEventsService
  ) {}

  /** In-app read (admin/lender/coop lead): computes on first read. */
  async getCoopScore(cooperativeId: string, actor: CoopScoreActor): Promise<CoopScoreRecord> {
    const chapter = await this.requireChapter(cooperativeId);
    assertReviewer(actor, chapter.leadUserId);
    const existing = await this.scores.latestFor(cooperativeId);
    if (existing) {
      return existing;
    }
    return this.computeAndMaybeAppend(cooperativeId, actor.id);
  }

  /** Partner-API read (no actor): 404 until a score exists — never computes. */
  async getCoopScoreForPartner(cooperativeId: string): Promise<CoopScoreRecord> {
    await this.requireChapter(cooperativeId);
    const existing = await this.scores.latestFor(cooperativeId);
    if (!existing) {
      throw new NotFoundException(`No score computed for cooperative '${cooperativeId}'`);
    }
    return existing;
  }

  /** Explicit recompute: appends a version only when the inputs changed. */
  async recompute(
    cooperativeId: string,
    actor: CoopScoreActor
  ): Promise<CoopScoreRecord & { recomputed: boolean }> {
    const chapter = await this.requireChapter(cooperativeId);
    assertReviewer(actor, chapter.leadUserId);
    return this.computeAndMaybeAppend(cooperativeId, actor.id);
  }

  private async requireChapter(cooperativeId: string) {
    const chapter = await this.chapters.findById(cooperativeId);
    if (!chapter) {
      throw new NotFoundException(`Cooperative '${cooperativeId}' not found`);
    }
    return chapter;
  }

  /**
   * Computes the current factor set and appends a new record ONLY when the
   * composite differs from the latest persisted version (idempotent
   * recompute). Emits coop_score.computed on append and
   * coop_score.band_changed when the band transitions.
   */
  private async computeAndMaybeAppend(
    cooperativeId: string,
    actorId: string
  ): Promise<CoopScoreRecord & { recomputed: boolean }> {
    const inputs = await this.gatherInputs(cooperativeId);
    const computed = computeCoopScore(inputs);
    const latest = await this.scores.latestFor(cooperativeId);

    if (latest && latest.score === computed.score && sameFactors(latest.factors, computed.factors)) {
      return { ...latest, recomputed: false };
    }

    const version = (latest?.version ?? 0) + 1;
    const record: CoopScoreRecord = {
      id: newId('coopscore'),
      cooperativeId,
      version,
      score: computed.score,
      band: computed.band,
      factors: computed.factors,
      dataAsOf: new Date().toISOString(),
      computedBy: actorId,
      createdAt: new Date().toISOString()
    };
    await this.scores.append(record);
    await this.events.publish('credit.coop_score.computed', {
      cooperativeId,
      version,
      score: record.score,
      band: record.band
    });
    if (latest && latest.band !== record.band) {
      await this.events.publish('credit.coop_score.band_changed', {
        cooperativeId,
        fromBand: latest.band,
        toBand: record.band,
        version
      });
    }
    return { ...record, recomputed: true };
  }

  /* ------------------------------ factor inputs ------------------------------ */

  private async gatherInputs(cooperativeId: string) {
    const [repayment, vsla, governance, commercial, data] = await Promise.all([
      this.guard('repaymentDiscipline', () => this.repaymentInputs(cooperativeId)),
      this.guard('vslaPerformance', () => this.vslaInputs(cooperativeId)),
      this.guard('governanceActivity', () => this.governanceInputs(cooperativeId)),
      this.guard('commercialReliability', () => this.commercialInputs(cooperativeId)),
      this.guard('dataCompleteness', () => this.dataInputs(cooperativeId))
    ]);
    return { repayment, vsla, governance, commercial, data };
  }

  /** Fail-closed: a throwing source module degrades its factor to unavailable. */
  private async guard<T>(
    _key: CoopScoreFactorKey,
    gather: () => Promise<T>
  ): Promise<T | { unavailable: true }> {
    try {
      return await gather();
    } catch {
      return { unavailable: true };
    }
  }

  private async memberUserIds(cooperativeId: string): Promise<string[]> {
    const groups = await this.creditGroups.find({ chapterId: cooperativeId });
    const ids = new Set<string>();
    for (const group of groups) {
      const members = await this.creditGroupMembers.listForGroup(group.id);
      for (const member of members) {
        ids.add(member.userId);
      }
    }
    // VSLA membership also defines the cooperative's active membership.
    const vslaGroups = await this.vslaGroups.find({ chapterId: cooperativeId });
    for (const group of vslaGroups) {
      const members = await this.vslaMembers.find({ groupId: group.id, status: 'ACTIVE' });
      for (const member of members) {
        ids.add(member.userId);
      }
    }
    return [...ids].sort();
  }

  private async repaymentInputs(cooperativeId: string) {
    const memberIds = new Set(await this.memberUserIds(cooperativeId));
    const loans = (await this.loans.all()).filter((loan) => memberIds.has(loan.applicantUserId));
    const loanIds = new Set(loans.map((loan) => loan.id));
    const installments = (await this.repayments.all()).filter((repayment) =>
      loanIds.has(repayment.loanId)
    );
    return { loans, installments };
  }

  private async vslaInputs(cooperativeId: string) {
    const groups = await this.vslaGroups.find({ chapterId: cooperativeId });
    const groupIds = new Set(groups.map((group) => group.id));
    const cycles = (await this.vslaCycles.all()).filter((cycle) => groupIds.has(cycle.groupId));
    const cycleIds = new Set(cycles.map((cycle) => cycle.id));
    const shareOuts = (await this.shareOuts.all()).filter((row) => cycleIds.has(row.cycleId));
    const shareOutPlans = (await this.shareOutPlans.all()).filter((row) =>
      cycleIds.has(row.cycleId)
    );
    return { cycles, shareOuts, shareOutPlans };
  }

  private async governanceInputs(cooperativeId: string) {
    const windowStart = new Date(Date.now() - GOVERNANCE_WINDOW_DAYS * DAY_MS).toISOString();
    const events = (await this.chapterEvents.find({ chapterId: cooperativeId })).filter(
      (event: ChapterEvent) => event.type === 'meeting' && event.startsAt >= windowStart
    );
    return { meetings: events, windowDays: GOVERNANCE_WINDOW_DAYS };
  }

  private async commercialInputs(cooperativeId: string) {
    const memberIds = new Set(await this.memberUserIds(cooperativeId));
    const sales = (await this.orders.all()).filter((order) => memberIds.has(order.sellerId));
    const orderIds = new Set(sales.map((order) => order.id));
    const escrows = (await this.escrows.all()).filter((row) => orderIds.has(row.orderId));
    return { sales, escrows };
  }

  private async dataInputs(cooperativeId: string) {
    const memberIds = await this.memberUserIds(cooperativeId);
    const profiles = [];
    for (const userId of memberIds) {
      const profile = await this.profiles.findById(userId);
      if (profile) {
        profiles.push(profile);
      }
    }
    const plots = (await this.plots.all()).filter((plot) => memberIds.includes(plot.ownerUserId));
    return { memberIds, profiles, plots };
  }
}

/** Factor equality for idempotent recompute (key + points + basis). */
function sameFactors(a: CoopScoreFactor[], b: CoopScoreFactor[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((factor, index) => {
    const other = b[index]!;
    return (
      factor.key === other.key &&
      factor.points === other.points &&
      factor.basis === other.basis
    );
  });
}

export type { CoopScoreBand };
