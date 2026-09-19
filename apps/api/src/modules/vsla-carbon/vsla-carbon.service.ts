import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type { LedgerJournalEntry, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  assertSameIdempotencyPayload,
  hashIdempotencyPayload
} from '../../common/idempotency/payload-hash.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CARBON_ESTIMATE_REPOSITORY,
  CARBON_EVIDENCE_REPOSITORY,
  CARBON_PLOT_REPOSITORY,
  CHAPTER_REPOSITORY,
  VSLA_CONTRIBUTION_REPOSITORY,
  VSLA_CYCLE_REPOSITORY,
  VSLA_GROUP_REPOSITORY,
  VSLA_LOAN_REPOSITORY,
  VSLA_LOAN_REPAYMENT_REPOSITORY,
  VSLA_MEETING_REPOSITORY,
  VSLA_CASH_COUNT_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_SHARE_OUT_PLAN_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type {
  CarbonEstimateRecord,
  CarbonEstimateRepository,
  CarbonEvidenceRecord,
  CarbonEvidenceRepository,
  CarbonPlotRepository,
  CarbonPracticeType,
  VslaCarbonPlotRecord,
  VslaCashCountRecord,
  VslaCashCountRepository,
  VslaContributionRecord,
  VslaContributionRepository,
  VslaCycleRecord,
  VslaCycleRepository,
  VslaGroupRecord,
  VslaGroupRepository,
  VslaLoanRecord,
  VslaLoanRepository,
  VslaLoanRepaymentRecord,
  VslaLoanRepaymentRepository,
  VslaMeetingRecord,
  VslaMeetingRepository,
  VslaMemberRecord,
  VslaMemberRepository,
  VslaMemberRole,
  VslaShareOutPlanRepository,
  VslaShareOutRecord,
  VslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService, type PreparedLedgerPost } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { UsersService } from '../users/users.service.js';
import {
  CARBON_COEFFICIENTS,
  CO2E_COEFFICIENT_VERSION,
  computeCo2eEstimateMilliTonnes,
  type CarbonCoefficient
} from './carbon-coefficients.js';
import { assertLoanTerms, simpleInterestKobo, totalDueKobo } from './loan-interest.js';
import { isNdviProviderError, NDVI_PROVIDER_TOKEN, type NdviProvider } from './ndvi.provider.js';
import { computeShareOut } from './share-out.js';

/** H3 resolution for plot registration (no PostGIS — app-layer h3-js). */
export const CARBON_PLOT_H3_RESOLUTION = 9;

export function groupCashAccountCode(groupId: string): string {
  return `vsla:${groupId}:cash`;
}

export function groupLoansReceivableAccountCode(groupId: string): string {
  return `vsla:${groupId}:loans_receivable`;
}

export function groupInterestIncomeAccountCode(groupId: string): string {
  return `vsla:${groupId}:interest_income`;
}

/** Per-member savings liability (credit-normal): what the group owes the member. */
export function memberSavingsAccountCode(groupId: string, userId: string): string {
  return `vsla:${groupId}:member:${userId}`;
}

/** Bad-debt expense (debit-normal): explicit loss recognition on write-off (V-10). */
export function groupBadDebtAccountCode(groupId: string): string {
  return `vsla:${groupId}:bad_debt`;
}

/** Cash-count shortage expense / overage revenue (V-48 reconciliation). */
export function groupCashShortageAccountCode(groupId: string): string {
  return `vsla:${groupId}:cash_shortage`;
}

export function groupCashOverageAccountCode(groupId: string): string {
  return `vsla:${groupId}:cash_overage`;
}

export interface CreateGroupInput {
  name: string;
  chapterId?: string;
  leadUserId?: string;
}

export interface AddMemberInput {
  userId: string;
  role?: VslaMemberRole;
}

export interface ContributionInput {
  memberId: string;
  amountKobo: number;
  idempotencyKey: string;
}

export interface IssueLoanInput {
  memberId: string;
  principalKobo: number;
  interestRateBps: number;
  /**
   * Client idempotency key (WP-G1, stage-27 V2 audit): MANDATORY. The ledger
   * idempotency key is derived from it, so a transport retry replays the
   * original loan instead of double-disbursing the pool; the same key with
   * a different payload is a 409.
   */
  idempotencyKey: string;
}

export interface RepaymentInput {
  amountKobo: number;
  idempotencyKey: string;
}

export interface RegisterPlotInput {
  groupId: string;
  ownerUserId?: string;
  name: string;
  practiceType: CarbonPracticeType;
  /** Hectares as a decimal (converted to centi-hectares). */
  hectares: number;
  centroidLat: number;
  centroidLong: number;
}

export interface SubmitEvidenceInput {
  season: string;
  survivalRatePct?: number;
  notes?: string;
  idempotencyKey: string;
  /** When true, link the Sentinel-2 NDVI assessment via the crop-ml contract. */
  linkNdvi?: boolean;
}

export interface ShareOutReport {
  cycleId: string;
  groupId: string;
  distributableKobo: number;
  payouts: VslaShareOutRecord[];
  /** Loans DEFAULTED at this close (V-10) — the claims persist and carry over. */
  defaultedLoanIds: string[];
  /** Arrears recovered by withholding from defaulters' shares (V-10). */
  arrearsRecoveredKobo: number;
  closedAt: string;
  /** True when this call replayed an already-completed close. */
  replayed: boolean;
}

export interface GroupMrvReport {
  groupId: string;
  groupName: string;
  plotCount: number;
  hectaresUnderPractice: number;
  /** Mean of each plot's latest observed survival rate; null when no evidence. */
  meanSurvivalRatePct: number | null;
  /** Sum of persisted estimates (tonnes CO2e, 3 decimals). */
  estimatedCo2eTonnes: number;
  estimateCount: number;
  evidenceCount: number;
  ndviLinkedEvidenceCount: number;
  /** Honest provenance flags present in every figure of this report. */
  basisFlags: Array<'stub' | 'estimate'>;
  /** ALWAYS present: these figures are estimates, not verification-grade. */
  disclaimer: string;
}

export interface ProgrammeMrvReport {
  groupCount: number;
  plotCount: number;
  hectaresUnderPractice: number;
  meanSurvivalRatePct: number | null;
  estimatedCo2eTonnes: number;
  estimateCount: number;
  evidenceCount: number;
  ndviLinkedEvidenceCount: number;
  basisFlags: Array<'stub' | 'estimate'>;
  disclaimer: string;
  groups: GroupMrvReport[];
  generatedAt: string;
}

export const ESTIMATE_DISCLAIMER =
  'Estimate only — not verification-grade; no carbon credits are issued, traded or implied.';

const SEASON_PATTERN = /^\d{4}(-(wet|dry))?$/;

function assertPositiveKobo(amountKobo: number, field = 'amountKobo'): void {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new BadRequestException(`${field} must be a positive integer kobo value`);
  }
}

function assertSeason(season: string): void {
  if (!SEASON_PATTERN.test(season)) {
    throw new BadRequestException("season must be 'YYYY', 'YYYY-wet' or 'YYYY-dry'");
  }
}

function isGroupAdmin(actor: User, group?: VslaGroupRecord): boolean {
  return (
    actor.roles.includes('admin') ||
    actor.roles.includes('chapter_lead') ||
    (group !== undefined && group.leadUserId === actor.id)
  );
}

function requireGroupAdmin(actor: User, group?: VslaGroupRecord): void {
  if (!isGroupAdmin(actor, group)) {
    throw new ForbiddenException('Only a chapter lead or admin may administer VSLA groups');
  }
}

/** Privileged cross-group read roles (V-13): platform oversight only. */
function isPrivilegedReader(actor: User): boolean {
  return actor.roles.includes('admin') || actor.roles.includes('regulator');
}

/**
 * V-48 audit threshold: a cash-count variance beyond max(5% of the ledger
 * balance, ₦100) is FLAGGED for review instead of quietly attested.
 */
export const CASH_COUNT_FLAG_THRESHOLD_PCT = 5;
export const CASH_COUNT_FLAG_MIN_KOBO = 10_000;

function isFlaggedVariance(varianceKobo: number, ledgerKobo: number): boolean {
  const threshold = Math.max(
    Math.floor((Math.abs(ledgerKobo) * CASH_COUNT_FLAG_THRESHOLD_PCT) / 100),
    CASH_COUNT_FLAG_MIN_KOBO
  );
  return Math.abs(varianceKobo) > threshold;
}

/**
 * VSLA groups + carbon MRV service (wave VSLACARBON).
 *
 * Money: ALL value movement posts through LedgerService — the group pool is
 * a set of ledger sub-accounts, never a parallel money store:
 *   contribution : DR vsla:<gid>:cash / CR vsla:<gid>:member:<uid>
 *   loan issue   : DR vsla:<gid>:loans_receivable (total due) /
 *                  CR vsla:<gid>:cash (principal) + CR vsla:<gid>:interest_income
 *   repayment    : DR vsla:<gid>:cash / CR vsla:<gid>:loans_receivable
 *   share-out    : DR vsla:<gid>:member:<uid> (+ vsla:<gid>:interest_income
 *                  for the surplus share) / CR vsla:<gid>:cash
 * Asset accounts carry solvency guards (never-negative) enforced inside the
 * ledger posting transaction, so overdrafts roll back atomically. Every
 * posting is idempotent by key, so transport retries replay safely.
 *
 * Carbon: plots carry an app-layer H3 res-9 index; evidence attestations
 * optionally link NDVI via the crop-ml contract behind a fail-closed
 * provider port; every figure is a deterministic ESTIMATE from the
 * versioned coefficient table and is labelled as such end-to-end.
 */
@Injectable()
export class VslaCarbonService {
  constructor(
    @Inject(VSLA_GROUP_REPOSITORY) private readonly groups: VslaGroupRepository,
    @Inject(VSLA_MEMBER_REPOSITORY) private readonly members: VslaMemberRepository,
    @Inject(VSLA_CYCLE_REPOSITORY) private readonly cycles: VslaCycleRepository,
    @Inject(VSLA_CONTRIBUTION_REPOSITORY) private readonly contributions: VslaContributionRepository,
    @Inject(VSLA_SHARE_OUT_REPOSITORY) private readonly shareOuts: VslaShareOutRepository,
    @Inject(VSLA_SHARE_OUT_PLAN_REPOSITORY)
    private readonly shareOutPlan: VslaShareOutPlanRepository,
    @Inject(VSLA_LOAN_REPOSITORY) private readonly loans: VslaLoanRepository,
    @Inject(VSLA_LOAN_REPAYMENT_REPOSITORY)
    private readonly repayments: VslaLoanRepaymentRepository,
    @Inject(CARBON_PLOT_REPOSITORY) private readonly plots: CarbonPlotRepository,
    @Inject(CARBON_EVIDENCE_REPOSITORY) private readonly evidence: CarbonEvidenceRepository,
    @Inject(CARBON_ESTIMATE_REPOSITORY) private readonly estimates: CarbonEstimateRepository,
    private readonly ledger: LedgerService,
    private readonly h3: H3Service,
    private readonly events: DomainEventsService,
    @Inject(NDVI_PROVIDER_TOKEN) private readonly ndvi: NdviProvider,
    @Inject(CHAPTER_REPOSITORY) private readonly chapters?: ChapterRepository,
    // FP-2 W2 V-48: meetings + dual-attested cash-count reconciliation.
    @Inject(VSLA_MEETING_REPOSITORY) private readonly meetings?: VslaMeetingRepository,
    @Inject(VSLA_CASH_COUNT_REPOSITORY) private readonly cashCounts?: VslaCashCountRepository,
    // OB-14: verification lookup for leadership grants. Optional so bare
    // unit-test constructions keep working; the global UsersModule always
    // wires it at runtime. Leadership grants FAIL CLOSED without it.
    @Optional() private readonly users?: UsersService
  ) {}

  // --------------------------------------------------------------- groups

  async createGroup(actor: User, input: CreateGroupInput): Promise<VslaGroupRecord> {
    requireGroupAdmin(actor);
    if (!input.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (input.chapterId && this.chapters) {
      // Chapter-linked group: the chapter must exist (chapters model).
      await this.chapters.getById(input.chapterId);
    }
    // OB-14: the lead takes group-fund signing authority — verify BEFORE any
    // write so a rejected lead leaves no half-created group behind.
    await this.assertLeadershipEligible(input.leadUserId ?? actor.id, 'lead');
    const id = newId('vsla');
    const now = new Date().toISOString();
    // Ledger sub-accounts up-front so every later posting finds them.
    await this.ledger.ensureAccount({
      code: groupCashAccountCode(id),
      type: 'asset',
      ownerId: input.leadUserId ?? actor.id
    });
    await this.ledger.ensureAccount({
      code: groupLoansReceivableAccountCode(id),
      type: 'asset',
      ownerId: input.leadUserId ?? actor.id
    });
    await this.ledger.ensureAccount({
      code: groupInterestIncomeAccountCode(id),
      type: 'revenue',
      ownerId: input.leadUserId ?? actor.id
    });
    const record = await this.groups.create({
      id,
      name: input.name.trim(),
      chapterId: input.chapterId,
      leadUserId: input.leadUserId ?? actor.id,
      status: 'ACTIVE',
      savingsAccountCode: groupCashAccountCode(id),
      loansReceivableAccountCode: groupLoansReceivableAccountCode(id),
      interestIncomeAccountCode: groupInterestIncomeAccountCode(id),
      createdAt: now,
      updatedAt: now
    });
    // The lead joins as the first member.
    await this.addMember(actor, id, { userId: record.leadUserId, role: 'lead' });
    await this.events.publish('vslacarbon.group.created', { groupId: id }, actor.id);
    return record;
  }

  async listGroups(actor: User): Promise<VslaGroupRecord[]> {
    const all = await this.groups.find({});
    if (
      actor.roles.includes('admin') ||
      actor.roles.includes('regulator') ||
      actor.roles.includes('donor') ||
      actor.roles.includes('chapter_lead')
    ) {
      return all;
    }
    const memberships = await this.members.find({ userId: actor.id });
    const mine = new Set(memberships.map((membership) => membership.groupId));
    return all.filter((group) => mine.has(group.id));
  }

  async getGroup(id: string): Promise<VslaGroupRecord> {
    const group = await this.groups.findById(id);
    if (!group) {
      throw new NotFoundException(`VSLA group '${id}' not found`);
    }
    return group;
  }

  /**
   * Read-side BOLA guard (V-13): a group's financial/carbon records may be
   * read by an ACTIVE member of the group, a platform admin or a regulator —
   * mirroring the membership filter listGroups already applies. Everyone
   * else (including chapter leads of OTHER chapters and ex-members) gets a
   * 403; an unknown group still 404s first.
   */
  private async assertGroupReader(actor: User, groupId: string): Promise<VslaGroupRecord> {
    const group = await this.getGroup(groupId);
    if (isPrivilegedReader(actor)) {
      return group;
    }
    const membership = await this.members.findByGroupAndUser(groupId, actor.id);
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException(
        'Only an active group member, a regulator or an admin may read VSLA group records'
      );
    }
    return group;
  }

  /** Group detail for an authenticated caller, membership-scoped (V-13). */
  async readGroup(actor: User, id: string): Promise<VslaGroupRecord> {
    return this.assertGroupReader(actor, id);
  }

  /**
   * OB-14: VSLA leadership (any non-'member' role, e.g. 'lead') requires a
   * verified identity — OTP-verified or KYC tier ≥ 1. An unverified tier_0
   * account may join as a plain member but may not hold signing/attestation
   * authority over group funds. Fails closed when the user directory is not
   * wired.
   */
  private async assertLeadershipEligible(userId: string, role: VslaMemberRole): Promise<void> {
    if (role === 'member') {
      return;
    }
    if (!this.users) {
      throw new ServiceUnavailableException(
        'User directory is not wired — VSLA leadership grants fail closed'
      );
    }
    const user = await this.users.getById(userId);
    if (!user.isVerified && user.kycTier === 'tier_0') {
      throw new ForbiddenException(
        `VSLA leadership role '${role}' requires a verified account (OTP-verified or KYC tier ≥ 1)`
      );
    }
  }

  async addMember(actor: User, groupId: string, input: AddMemberInput): Promise<VslaMemberRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group);
    const existing = await this.members.findByGroupAndUser(groupId, input.userId);
    if (existing) {
      return existing; // idempotent re-join
    }
    await this.assertLeadershipEligible(input.userId, input.role ?? 'member');
    await this.ledger.ensureAccount({
      code: memberSavingsAccountCode(groupId, input.userId),
      type: 'liability',
      ownerId: input.userId
    });
    const member = await this.members.create({
      id: newId('vslamember'),
      groupId,
      userId: input.userId,
      role: input.role ?? 'member',
      status: 'ACTIVE',
      joinedAt: new Date().toISOString()
    });
    await this.events.publish('vslacarbon.member.added', { groupId, memberId: member.id }, actor.id);
    return member;
  }

  async listMembers(actor: User, groupId: string): Promise<VslaMemberRecord[]> {
    await this.assertGroupReader(actor, groupId);
    return this.members.find({ groupId });
  }

  // ------------------------------------------------------------ cycles

  /**
   * Group lifecycle exit (V-47): a group admin dissolves the group. Blocked
   * while a cycle is OPEN or any loan claim is outstanding (ACTIVE/DEFAULTED)
   * — close the cycle and settle/default-write-off loans first. Also blocked
   * while pooled cash remains (members would silently lose residual claims;
   * settle via exit/close first). CAS transition; replay-safe.
   */
  async dissolveGroup(actor: User, groupId: string): Promise<VslaGroupRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group);
    if (group.status === 'DISSOLVED') {
      return group; // replay-safe
    }
    const openCycle = await this.cycles.findOpenByGroup(groupId);
    if (openCycle) {
      throw new ConflictException(
        'Cannot dissolve with an open cycle — close the cycle (share-out) first'
      );
    }
    const outstanding = await this.loans.find({ groupId });
    const live = outstanding.filter(
      (loan) =>
        (loan.status === 'ACTIVE' || loan.status === 'DEFAULTED') &&
        loan.repaidKobo < loan.totalDueKobo
    );
    if (live.length > 0) {
      throw new ConflictException(
        `Cannot dissolve with ${live.length} outstanding loan claim(s) — repay, net or write them off first`
      );
    }
    const { balanceKobo: cashKobo } = await this.ledger.balance(groupCashAccountCode(groupId));
    if (cashKobo > 0) {
      throw new ConflictException(
        'Cannot dissolve while pooled cash remains — settle member residuals (exit/share-out) first'
      );
    }
    const dissolved = await this.groups.updateExpected(
      groupId,
      { status: 'DISSOLVED', updatedAt: new Date().toISOString() },
      { status: 'ACTIVE' }
    );
    await this.events.publish('vslacarbon.group.dissolved', { groupId }, actor.id);
    return dissolved;
  }

  /**
   * Member lifecycle exit (V-47): the member themself or a group admin exits
   * a member. Blocked while a cycle is OPEN (funds are locked in the pool)
   * or the member holds an outstanding loan claim (ACTIVE/DEFAULTED). The
   * member's remaining savings balance is settled to their wallet
   * (DR member savings / CR group cash, solvency-guarded, entity-keyed) and
   * the member row CAS-transitions to EXITED. Replay-safe.
   */
  async exitGroup(actor: User, groupId: string, memberId?: string): Promise<VslaMemberRecord> {
    const group = await this.getGroup(groupId);
    let member: VslaMemberRecord | undefined;
    if (memberId) {
      requireGroupAdmin(actor, group);
      member = await this.members.findById(memberId);
    } else {
      member = await this.members.findByGroupAndUser(groupId, actor.id);
    }
    if (!member || member.groupId !== groupId) {
      throw new NotFoundException(`VSLA member '${memberId ?? actor.id}' not found in group`);
    }
    if (member.status === 'EXITED') {
      return member; // replay-safe
    }
    const openCycle = await this.cycles.findOpenByGroup(groupId);
    if (openCycle) {
      throw new ConflictException(
        'Cannot exit during an open cycle — contributions are locked until share-out'
      );
    }
    const loans = await this.loans.find({ groupId, memberId: member.id });
    const live = loans.filter(
      (loan) =>
        (loan.status === 'ACTIVE' || loan.status === 'DEFAULTED') &&
        loan.repaidKobo < loan.totalDueKobo
    );
    if (live.length > 0) {
      throw new ConflictException(
        'Cannot exit with an outstanding loan — repay, await arrears netting or write-off first'
      );
    }
    // Share settlement: pay out whatever the group still owes the member.
    const balance = await this.ledger.balance(
      memberSavingsAccountCode(groupId, member.userId)
    );
    const claimKobo = balance.creditsKobo - balance.debitsKobo;
    if (claimKobo > 0) {
      await this.ledger.postEntry(
        {
          idempotencyKey: `vsla-member-exit:${member.id}`,
          referenceType: 'vsla_member_exit',
          referenceId: member.id,
          description: `VSLA member exit settlement ${member.id} (group ${groupId})`,
          postings: [
            {
              accountCode: memberSavingsAccountCode(groupId, member.userId),
              direction: 'debit',
              amountKobo: claimKobo
            },
            {
              accountCode: groupCashAccountCode(groupId),
              direction: 'credit',
              amountKobo: claimKobo
            }
          ],
          // Never-negative: the pool cannot pay cash it does not hold.
          requireSolventAccounts: [groupCashAccountCode(groupId)]
        },
        actor.id
      );
    }
    const exited = await this.members.updateExpected(
      member.id,
      { status: 'EXITED' },
      { status: 'ACTIVE' }
    );
    await this.events.publish(
      'vslacarbon.member.exited',
      { groupId, memberId: member.id, settledKobo: Math.max(0, claimKobo) },
      actor.id
    );
    return exited;
  }

  // ------------------------------------ meetings + cash reconciliation (V-48)

  /** Fail closed when the V-48 repositories are not wired. */
  private reconciliationRepos(): {
    meetings: VslaMeetingRepository;
    cashCounts: VslaCashCountRepository;
  } {
    if (!this.meetings || !this.cashCounts) {
      throw new InternalServerErrorException(
        'VSLA reconciliation repositories are not wired (VSLA_MEETING/CASH_COUNT_REPOSITORY)'
      );
    }
    return { meetings: this.meetings, cashCounts: this.cashCounts };
  }

  /** Record a group meeting (the governance anchor for cash counts). */
  async recordMeeting(
    actor: User,
    groupId: string,
    input: { heldAt?: string; notes?: string }
  ): Promise<VslaMeetingRecord> {
    const group = await this.getGroup(groupId);
    if (group.status !== 'ACTIVE') {
      throw new ConflictException('Cannot record meetings for a dissolved group');
    }
    await this.assertGroupReader(actor, groupId); // active member/admin/regulator
    const now = new Date().toISOString();
    return this.reconciliationRepos().meetings.create({
      id: newId('vslameet'),
      groupId,
      heldAt: input.heldAt ?? now,
      notes: input.notes?.trim() || undefined,
      createdBy: actor.id,
      createdAt: now
    });
  }

  async listMeetings(actor: User, groupId: string): Promise<VslaMeetingRecord[]> {
    await this.assertGroupReader(actor, groupId);
    return this.reconciliationRepos().meetings.find({ groupId });
  }

  /**
   * Treasurer declares the physical lockbox count (PENDING). Dual attestation
   * (attestCashCount) by a DIFFERENT active member settles it. Idempotent by
   * client key.
   */
  async declareCashCount(
    actor: User,
    groupId: string,
    input: { declaredKobo: number; meetingId?: string; idempotencyKey: string }
  ): Promise<VslaCashCountRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group); // the treasurer/lead declares
    if (!Number.isSafeInteger(input.declaredKobo) || input.declaredKobo < 0) {
      throw new BadRequestException('declaredKobo must be a non-negative integer');
    }
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required');
    }
    if (group.status !== 'ACTIVE') {
      throw new ConflictException('Cannot declare cash counts for a dissolved group');
    }
    const { meetings, cashCounts } = this.reconciliationRepos();
    const replay = await cashCounts.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay;
    }
    if (input.meetingId) {
      const meeting = await meetings.findById(input.meetingId);
      if (!meeting || meeting.groupId !== groupId) {
        throw new NotFoundException(`VSLA meeting '${input.meetingId}' not found in this group`);
      }
    }
    return cashCounts.create({
      id: newId('vslacashcount'),
      groupId,
      meetingId: input.meetingId,
      declaredKobo: input.declaredKobo,
      declaredBy: actor.id,
      status: 'PENDING',
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString()
    });
  }

  async listCashCounts(actor: User, groupId: string): Promise<VslaCashCountRecord[]> {
    await this.assertGroupReader(actor, groupId);
    return this.reconciliationRepos().cashCounts.find({ groupId });
  }

  /**
   * Dual attestation (V-48): a DIFFERENT active member (or an admin who is
   * not the declarer) attests the count. The ledger balance is captured, the
   * variance (declared − ledger) posts as a balanced adjustment (shortage →
   * DR cash_shortage expense / CR cash; overage → DR cash / CR cash_overage
   * revenue) and the record lands ATTESTED, or FLAGGED when the variance
   * exceeds the audit threshold. The adjustment entry is entity-keyed so a
   * crash/replay resumes instead of double-posting.
   */
  async attestCashCount(actor: User, countId: string): Promise<VslaCashCountRecord> {
    const { cashCounts } = this.reconciliationRepos();
    const count = await cashCounts.findById(countId);
    if (!count) {
      throw new NotFoundException(`VSLA cash count '${countId}' not found`);
    }
    if (actor.id === count.declaredBy) {
      // Dual attestation: the treasurer cannot attest their own count.
      throw new ForbiddenException('The declarer cannot attest their own cash count');
    }
    if (!actor.roles.includes('admin')) {
      await this.assertGroupReader(actor, count.groupId); // active member / regulator
    }
    if (count.status !== 'PENDING') {
      // Crash-resume: the record settled but the adjustment entry may be
      // missing (crash between CAS and post) — re-drive it idempotently.
      if (!count.ledgerEntryId && (count.varianceKobo ?? 0) !== 0) {
        const ledgerEntryId = await this.postCashCountAdjustment(
          count.groupId,
          count.id,
          count.varianceKobo ?? 0,
          actor.id
        );
        return cashCounts.updateExpected(count.id, { ledgerEntryId }, { status: count.status });
      }
      return count; // replay
    }
    const { balanceKobo: ledgerKobo } = await this.ledger.balance(
      groupCashAccountCode(count.groupId)
    );
    const varianceKobo = count.declaredKobo - ledgerKobo;
    const status = isFlaggedVariance(varianceKobo, ledgerKobo) ? 'FLAGGED' : 'ATTESTED';
    const ledgerEntryId =
      varianceKobo !== 0
        ? await this.postCashCountAdjustment(count.groupId, count.id, varianceKobo, actor.id)
        : undefined;
    const updated = await cashCounts.updateExpected(
      count.id,
      {
        ledgerKobo,
        varianceKobo,
        attestedBy: actor.id,
        status,
        ledgerEntryId,
        attestedAt: new Date().toISOString()
      },
      { status: 'PENDING' }
    );
    await this.events.publish(
      'vslacarbon.cashcount.attested',
      {
        groupId: count.groupId,
        cashCountId: count.id,
        ledgerKobo,
        varianceKobo,
        status,
        attestedBy: actor.id
      },
      actor.id
    );
    return updated;
  }

  /**
   * Balanced variance adjustment (V-48): shortage (variance &lt; 0, box holds
   * LESS than the books) expenses the difference and reduces book cash;
   * overage books the excess as revenue. Solvency-guarded on the cash leg.
   */
  private async postCashCountAdjustment(
    groupId: string,
    countId: string,
    varianceKobo: number,
    actorId: string
  ): Promise<string> {
    const amountKobo = Math.abs(varianceKobo);
    const shortage = varianceKobo < 0;
    const adjustmentAccount = shortage
      ? groupCashShortageAccountCode(groupId)
      : groupCashOverageAccountCode(groupId);
    await this.ledger.ensureAccount({
      code: adjustmentAccount,
      type: shortage ? 'expense' : 'revenue',
      ownerId: actorId
    });
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `vsla-cashcount:${countId}`,
        referenceType: 'vsla_cash_count',
        referenceId: countId,
        description: `VSLA cash-count variance adjustment ${countId} (${shortage ? 'shortage' : 'overage'})`,
        postings: shortage
          ? [
              { accountCode: adjustmentAccount, direction: 'debit', amountKobo },
              { accountCode: groupCashAccountCode(groupId), direction: 'credit', amountKobo }
            ]
          : [
              { accountCode: groupCashAccountCode(groupId), direction: 'debit', amountKobo },
              { accountCode: adjustmentAccount, direction: 'credit', amountKobo }
            ],
        // Never-negative: a shortage cannot exceed the book cash balance.
        requireSolventAccounts: shortage ? [groupCashAccountCode(groupId)] : []
      },
      actorId
    );
    return entry.id;
  }

  async openCycle(actor: User, groupId: string, label: string): Promise<VslaCycleRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group);
    if (group.status !== 'ACTIVE') {
      throw new ConflictException('Cannot open a cycle for a dissolved group');
    }
    if (!label?.trim()) {
      throw new BadRequestException('label is required');
    }
    const cycle = await this.cycles.create({
      id: newId('vslacycle'),
      groupId,
      label: label.trim(),
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    await this.events.publish('vslacarbon.cycle.opened', { groupId, cycleId: cycle.id }, actor.id);
    return cycle;
  }

  async listCycles(actor: User, groupId: string): Promise<VslaCycleRecord[]> {
    await this.assertGroupReader(actor, groupId);
    return this.cycles.find({ groupId });
  }

  async getCycle(id: string): Promise<VslaCycleRecord> {
    const cycle = await this.cycles.findById(id);
    if (!cycle) {
      throw new NotFoundException(`VSLA cycle '${id}' not found`);
    }
    return cycle;
  }

  async contribute(
    actor: User,
    cycleId: string,
    input: ContributionInput
  ): Promise<VslaContributionRecord> {
    const cycle = await this.getCycle(cycleId);
    if (cycle.status !== 'OPEN') {
      throw new ConflictException('Contributions are only accepted into an OPEN cycle');
    }
    assertPositiveKobo(input.amountKobo);
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required');
    }
    const member = await this.requireActiveMember(cycle.groupId, input.memberId);
    if (
      member.userId !== actor.id &&
      !isGroupAdmin(actor, await this.getGroup(cycle.groupId)) &&
      !actor.roles.includes('enumerator')
    ) {
      throw new ForbiddenException('Members may only record their own contributions');
    }
    // Canonical payload fingerprint (WP-G11): stored with the key so the
    // same key with a DIFFERENT payload is a 409 instead of a silent replay.
    const payloadHash = hashIdempotencyPayload({
      cycleId,
      memberId: member.id,
      amountKobo: input.amountKobo
    });
    // Idempotent replay: the same client key with the same payload returns
    // the original record; a divergent payload fails closed with a 409.
    const replay = await this.contributions.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      assertSameIdempotencyPayload(replay.idempotencyKey, replay.payloadHash, payloadHash);
      return replay;
    }
    let record: VslaContributionRecord;
    try {
      const entry = await this.ledger.postEntry(
        {
          idempotencyKey: `vsla-contribution:${input.idempotencyKey}`,
          referenceType: 'vsla_contribution',
          referenceId: cycleId,
          description: `VSLA contribution cycle ${cycleId} member ${member.id}`,
          postings: [
            {
              accountCode: groupCashAccountCode(cycle.groupId),
              direction: 'debit',
              amountKobo: input.amountKobo
            },
            {
              accountCode: memberSavingsAccountCode(cycle.groupId, member.userId),
              direction: 'credit',
              amountKobo: input.amountKobo
            }
          ]
        },
        actor.id
      );
      record = await this.contributions.create({
        id: newId('vslacontrib'),
        cycleId,
        groupId: cycle.groupId,
        memberId: member.id,
        amountKobo: input.amountKobo,
        idempotencyKey: input.idempotencyKey,
        ledgerEntryId: entry.id,
        payloadHash,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        // Adopt-on-23505 (WP-G11): a concurrent twin with the same client
        // key committed first — under pg its posting insert AND its
        // contribution row serialise on the same UNIQUE keys, so a loser
        // can surface the conflict from either. Adopt the twin when the
        // payload matches (the ledger key is derived from the client key,
        // so the losing posting moved no extra money); 409 when it does
        // not.
        const twin = await this.findContributionTwin(input.idempotencyKey);
        if (twin) {
          assertSameIdempotencyPayload(twin.idempotencyKey, twin.payloadHash, payloadHash);
          return twin;
        }
      }
      throw error;
    }
    await this.events.publish(
      'vslacarbon.contribution.recorded',
      { cycleId, contributionId: record.id },
      actor.id
    );
    return record;
  }

  /**
   * Bounded-retry twin lookup for adopt-on-23505 (WP-G11): the winner's
   * ledger entry commits before its contribution row, so the loser's
   * conflict can surface a tick before the row is visible. Mirrors the
   * bounded-retry doctrine of the repayment adopt path.
   */
  private async findContributionTwin(
    idempotencyKey: string,
    attempts = 3
  ): Promise<VslaContributionRecord | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await this.contributions.findByIdempotencyKey(idempotencyKey);
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return undefined;
  }

  async listContributions(actor: User, cycleId: string): Promise<VslaContributionRecord[]> {
    const cycle = await this.getCycle(cycleId);
    await this.assertGroupReader(actor, cycle.groupId);
    return this.contributions.find({ cycleId });
  }

  /**
   * Close a cycle and run the deterministic pro-rata share-out. CAS on
   * OPEN→CLOSED elects a single closer; the computed distribution plan is
   * persisted BEFORE the first payout posts (stage-24 audit A4-4), so
   * crash-resume pays the remaining members from the persisted plan — shares
   * are never recomputed from the reduced pool. Replays (and retried closes
   * after a partial post) re-post idempotently via the ledger/share-out
   * unique keys and return the same report.
   */
  async closeCycle(actor: User, cycleId: string): Promise<ShareOutReport> {
    const cycle = await this.getCycle(cycleId);
    const group = await this.getGroup(cycle.groupId);
    requireGroupAdmin(actor, group);
    // V-10: loans of the closing cycle that are still open are DEFAULTED
    // BEFORE the close commits — the claim is explicit, never silently
    // socialised. CAS-per-loan makes the loop crash/concurrency safe: an
    // already-defaulted (or concurrently defaulted) loan is simply skipped,
    // and a replay after a mid-loop crash re-enters here because the cycle
    // is still OPEN.
    const defaultedLoanIds: string[] = [];
    if (cycle.status !== 'CLOSED') {
      const openLoans = (await this.loans.find({ groupId: cycle.groupId, cycleId })).filter(
        (loan) => loan.status === 'ACTIVE'
      );
      for (const loan of openLoans) {
        if (loan.repaidKobo >= loan.totalDueKobo) continue;
        try {
          await this.loans.updateExpected(loan.id, { status: 'DEFAULTED' }, { status: 'ACTIVE' });
          defaultedLoanIds.push(loan.id);
        } catch (error) {
          // A concurrent closer/repayment moved it first — re-read wins.
          if (!(error instanceof ConflictException)) throw error;
          const moved = await this.loans.findById(loan.id);
          if (moved?.status === 'DEFAULTED') defaultedLoanIds.push(loan.id);
        }
      }
    }
    let replayed = false;
    if (cycle.status === 'CLOSED') {
      replayed = true;
    } else {
      const closed = await this.cycles.updateExpected(
        cycleId,
        { status: 'CLOSED', closedAt: new Date().toISOString() },
        { status: 'OPEN' }
      );
      cycle.status = closed.status;
      cycle.closedAt = closed.closedAt;
    }

    // Persisted distribution plan (stage-24 audit A4-4): the pro-rata payout
    // vector is computed ONCE from the pre-payout pool snapshot and stored
    // BEFORE any money moves. Crash-resume (and concurrent closers) pay the
    // remaining members from the PERSISTED plan — shares are never recomputed
    // from the reduced live pool, which previously underpaid members, stranded
    // funds in the pool and falsified the close report.
    //
    // WP-G1 (stage-27 V2 audit): a plan is trusted ONLY with its completion
    // marker. Pre-054 rows were inserted one-by-one in autocommit, so a crash
    // mid-insert left a PARTIAL plan that any non-empty check mistook for
    // complete — permanently underpaying unplanned members. The writer now
    // inserts ALL rows plus the marker in one transaction (replacePlan), and
    // unmarked rows are rebuilt, never paid.
    let plan = await this.shareOutPlan.find({ cycleId });
    let meta = await this.shareOutPlan.findMeta(cycleId);
    if (!meta && plan.length > 0) {
      // Rows without a marker: either a complete LEGACY plan or a partial
      // one. Recorded payouts prove the insert loop finished (payouts start
      // only after it), so a plan with payouts is complete — backfill its
      // marker. Anything else is a crash-truncated plan: rebuild it below
      // (no payout has posted, so the pool is intact and the deterministic
      // recompute yields identical shares).
      const recorded = await this.shareOuts.find({ cycleId });
      if (recorded.length > 0) {
        await this.shareOutPlan.markPlanComplete(
          cycleId,
          plan.length,
          plan.reduce((sum, row) => sum + row.shareKobo, 0)
        );
        meta = await this.shareOutPlan.findMeta(cycleId);
      } else {
        plan = [];
      }
    }
    if (!meta) {
      const cycleContributions = await this.contributions.find({ cycleId });
      const memberIds = [...new Set(cycleContributions.map((row) => row.memberId))];
      const memberRows: Array<{ memberId: string; contributedKobo: number }> = [];
      for (const memberId of memberIds) {
        const member = await this.members.findById(memberId);
        if (!member) continue;
        const contributedKobo = cycleContributions
          .filter((row) => row.memberId === memberId)
          .reduce((sum, row) => sum + row.amountKobo, 0);
        memberRows.push({ memberId, contributedKobo });
      }

      // The distributable pool is the pooled-cash ledger balance — the ledger
      // is the source of truth for money; the plan table freezes the outcome.
      const { balanceKobo: distributableKobo } = await this.ledger.balance(
        groupCashAccountCode(cycle.groupId)
      );
      const payouts = computeShareOut(memberRows, Math.max(0, distributableKobo));
      // V-10: shares are NET OF ARREARS — a member's outstanding DEFAULTED
      // loans (any cycle of this group, so arrears carry over) are withheld
      // from their gross share and applied against the loans_receivable claim
      // instead of being paid out as cash. The withheld amounts are frozen in
      // the plan so crash-resume replays the identical netting.
      const arrearsByMember = new Map<string, number>();
      for (const payout of payouts) {
        const defaulted = await this.loans.find({
          groupId: cycle.groupId,
          memberId: payout.memberId,
          status: 'DEFAULTED'
        });
        const arrearsKobo = defaulted.reduce(
          (sum, loan) => sum + (loan.totalDueKobo - loan.repaidKobo),
          0
        );
        arrearsByMember.set(payout.memberId, Math.min(payout.shareKobo, arrearsKobo));
      }
      const now = new Date().toISOString();
      // One atomic unit: partial rows are deleted, the FULL plan and its
      // completion marker commit together; a concurrent closer loses the
      // marker race and re-reads the winner's plan below.
      await this.shareOutPlan.replacePlan(
        cycleId,
        payouts.map((payout) => ({
          id: newId('vslaplan'),
          cycleId,
          memberId: payout.memberId,
          shareKobo: payout.shareKobo,
          contributedKobo: payout.contributedKobo,
          residualKobo: payout.residualKobo,
          arrearsWithheldKobo: arrearsByMember.get(payout.memberId) ?? 0,
          createdAt: now
        })),
        {
          cycleId,
          rowCount: payouts.length,
          totalShareKobo: payouts.reduce((sum, payout) => sum + payout.shareKobo, 0),
          createdAt: now
        }
      );
      // Re-read so every closer pays from the same authoritative stored plan.
      plan = await this.shareOutPlan.find({ cycleId });
    }

    const records: VslaShareOutRecord[] = [];
    for (const planned of plan) {
      const existing = (await this.shareOuts.find({ cycleId, memberId: planned.memberId }))[0];
      if (existing) {
        records.push(existing);
        continue;
      }
      const member = await this.members.findById(planned.memberId);
      if (!member) {
        // Fail closed: silently skipping a planned member would strand funds.
        throw new NotFoundException(
          `VSLA member '${planned.memberId}' from the persisted share-out plan not found`
        );
      }
      // V-10: apply the plan-frozen arrears withholding against the member's
      // DEFAULTED loans FIRST — the cash payout is the gross share minus what
      // was actually recovered (a concurrent repayment between plan and
      // payout shrinks the recovery, never double-claims).
      const plannedWithheldKobo = planned.arrearsWithheldKobo ?? 0;
      const arrearsRecoveredKobo =
        plannedWithheldKobo > 0
          ? await this.recoverArrearsFromShare(cycle, member, plannedWithheldKobo, actor)
          : 0;
      const cashShareKobo = planned.shareKobo - arrearsRecoveredKobo;
      let entryId = '';
      if (cashShareKobo > 0) {
        const memberDebit = Math.min(
          cashShareKobo,
          Math.max(0, planned.contributedKobo - arrearsRecoveredKobo)
        );
        const surplusDebit = cashShareKobo - memberDebit;
        const postings = [
          {
            accountCode: memberSavingsAccountCode(cycle.groupId, member.userId),
            direction: 'debit' as const,
            amountKobo: memberDebit
          },
          ...(surplusDebit > 0
            ? [
                {
                  accountCode: groupInterestIncomeAccountCode(cycle.groupId),
                  direction: 'debit' as const,
                  amountKobo: surplusDebit
                }
              ]
            : []),
          {
            accountCode: groupCashAccountCode(cycle.groupId),
            direction: 'credit' as const,
            amountKobo: cashShareKobo
          }
        ].filter((posting) => posting.amountKobo > 0);
        const entry = await this.ledger.postEntry(
          {
            idempotencyKey: `vsla-shareout:${cycleId}:${planned.memberId}`,
            referenceType: 'vsla_share_out',
            referenceId: cycleId,
            description: `VSLA share-out cycle ${cycleId} member ${planned.memberId}`,
            postings,
            // Never-negative: the pooled cash is debit-normal and must not
            // dip below zero; the check runs inside the posting transaction
            // so a shortfall rolls back atomically. The interest-income
            // revenue account is CREDIT-normal (negative balance until
            // distributed), so it is deliberately not solvency-guarded —
            // the surplus share can never exceed the interest credited
            // (surplus = repayments - outstanding principal <= interest
            // booked at issuance).
            requireSolventAccounts: [groupCashAccountCode(cycle.groupId)]
          },
          actor.id
        );
        entryId = entry.id;
      }
      try {
        records.push(
          await this.shareOuts.create({
            id: newId('vslashareout'),
            cycleId,
            memberId: planned.memberId,
            shareKobo: cashShareKobo,
            contributedKobo: planned.contributedKobo,
            residualKobo: planned.residualKobo,
            arrearsWithheldKobo: arrearsRecoveredKobo,
            ledgerEntryId: entryId,
            createdAt: new Date().toISOString()
          })
        );
      } catch (error) {
        if (error instanceof ConflictException) {
          // Concurrent close already recorded this member — reuse their row.
          const concurrent = (await this.shareOuts.find({ cycleId, memberId: planned.memberId }))[0];
          if (concurrent) records.push(concurrent);
          continue;
        }
        throw error;
      }
    }
    // Conservation: the recorded payouts (net cash + withheld arrears) always
    // equal the persisted plan total. On a crash-resume the live pool balance
    // is already (partially) paid out, so report totals come from the
    // plan/recorded payouts — never from the reduced balance.
    const reportedDistributable =
      records.reduce((sum, record) => sum + record.shareKobo, 0) +
      records.reduce((sum, record) => sum + (record.arrearsWithheldKobo ?? 0), 0);
    const arrearsRecoveredKobo = records.reduce(
      (sum, record) => sum + (record.arrearsWithheldKobo ?? 0),
      0
    );
    // On replay, recover the defaulted-loan set from the loans themselves.
    const reportedDefaulted = replayed
      ? (await this.loans.find({ groupId: cycle.groupId, cycleId, status: 'DEFAULTED' })).map(
          (loan) => loan.id
        )
      : defaultedLoanIds;
    await this.events.publish(
      'vslacarbon.cycle.closed',
      {
        groupId: cycle.groupId,
        cycleId,
        distributableKobo: reportedDistributable,
        defaultedLoanIds: reportedDefaulted,
        arrearsRecoveredKobo
      },
      actor.id
    );
    return {
      cycleId,
      groupId: cycle.groupId,
      distributableKobo: reportedDistributable,
      payouts: records,
      defaultedLoanIds: reportedDefaulted,
      arrearsRecoveredKobo,
      closedAt: cycle.closedAt ?? new Date().toISOString(),
      replayed
    };
  }

  /**
   * V-10: apply the plan-frozen arrears withholding against the member's
   * DEFAULTED loans (oldest first). Each per-loan recovery is the repayLoan
   * fold — claim-first CAS + balanced repayment entry (DR member savings /
   * CR loans_receivable) + repayment row in ONE unit of work — keyed by
   * `shareout-arrears:{cycleId}:{loanId}` so crash-resume and concurrent
   * closers ADOPT the stored row instead of double-claiming, and the
   * phantom-claim reconciler sees a committed entry backing every claim.
   * Returns the total actually recovered (≤ withheldKobo when a concurrent
   * repayment settled part of the arrears between plan and payout).
   */
  private async recoverArrearsFromShare(
    cycle: VslaCycleRecord,
    member: VslaMemberRecord,
    withheldKobo: number,
    actor: User
  ): Promise<number> {
    let remaining = withheldKobo;
    let recovered = 0;
    const defaulted = (
      await this.loans.find({ groupId: cycle.groupId, memberId: member.id, status: 'DEFAULTED' })
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const loan of defaulted) {
      if (remaining <= 0) break;
      const recoveryKey = `shareout-arrears:${cycle.id}:${loan.id}`;
      const existing = await this.repayments.findByIdempotencyKey(recoveryKey);
      if (existing) {
        // Crash-resume / concurrent closer: adopt the stored recovery row.
        recovered += existing.amountKobo;
        remaining -= existing.amountKobo;
        continue;
      }
      const portion = Math.min(remaining, loan.totalDueKobo - loan.repaidKobo);
      if (portion <= 0) continue;
      const applied = await this.loans.withLoanTransaction(loan.id, async (tx) => {
        const claim = await this.loans.claimRepayment(loan.id, portion, tx);
        if (!claim) {
          return 0; // raced: the loan was settled concurrently — move on
        }
        const posted = await this.ledger.postEntryInTx(
          tx,
          {
            idempotencyKey: `vsla-loan-repayment:${recoveryKey}`,
            referenceType: 'vsla_loan_repayment',
            referenceId: loan.id,
            description: `VSLA arrears recovery from share-out (cycle ${cycle.id}, loan ${loan.id})`,
            postings: [
              {
                accountCode: memberSavingsAccountCode(cycle.groupId, member.userId),
                direction: 'debit',
                amountKobo: portion
              },
              {
                accountCode: groupLoansReceivableAccountCode(cycle.groupId),
                direction: 'credit',
                amountKobo: portion
              }
            ],
            // Never-negative: recovery cannot exceed the receivable balance.
            requireSolventAccounts: [groupLoansReceivableAccountCode(cycle.groupId)]
          },
          actor.id
        );
        const amountKobo = this.entryAmountKobo(posted.entry);
        await this.repayments.create(
          {
            id: newId('vslarepay'),
            loanId: loan.id,
            amountKobo,
            idempotencyKey: recoveryKey,
            ledgerEntryId: posted.entry.id,
            payloadHash: hashIdempotencyPayload({ loanId: loan.id, amountKobo }),
            createdAt: new Date().toISOString()
          },
          tx
        );
        return amountKobo;
      });
      recovered += applied;
      remaining -= applied;
    }
    return recovered;
  }

  async getShareOut(actor: User, cycleId: string): Promise<VslaShareOutRecord[]> {
    const cycle = await this.getCycle(cycleId);
    await this.assertGroupReader(actor, cycle.groupId);
    return this.shareOuts.find({ cycleId });
  }

  // --------------------------------------------------------------- loans

  /**
   * Issues an internal loan from the pool. Exactly-once by client key
   * (WP-G1, stage-27 V2 audit): the disbursement posting and the loan row
   * commit in ONE caller-owned transaction (pg) keyed by the client
   * idempotency key — a transport retry replays the stored loan, a
   * concurrent twin loses the unique-key race and adopts it, and the same
   * key with a different payload is a 409. Before this fix the ledger key
   * contained a per-call loanId, so any retry double-disbursed the pool.
   */
  async issueLoan(actor: User, groupId: string, input: IssueLoanInput): Promise<VslaLoanRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group);
    assertLoanTerms(input.principalKobo, input.interestRateBps);
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required');
    }
    const cycle = await this.cycles.findOpenByGroup(groupId);
    if (!cycle) {
      throw new ConflictException('Loans are only issued against an open cycle');
    }
    const member = await this.requireActiveMember(groupId, input.memberId);

    // Idempotent replay: the same client key returns the original loan.
    const existing = await this.loans.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return this.assertLoanIssuePayload(existing, groupId, member.id, input);
    }

    const interestKobo = simpleInterestKobo(input.principalKobo, input.interestRateBps);
    const totalKobo = totalDueKobo(input.principalKobo, input.interestRateBps);
    const postings = [
      {
        accountCode: groupLoansReceivableAccountCode(groupId),
        direction: 'debit' as const,
        amountKobo: totalKobo
      },
      {
        accountCode: groupCashAccountCode(groupId),
        direction: 'credit' as const,
        amountKobo: input.principalKobo
      },
      ...(interestKobo > 0
        ? [
            {
              accountCode: groupInterestIncomeAccountCode(groupId),
              direction: 'credit' as const,
              amountKobo: interestKobo
            }
          ]
        : [])
    ];
    const loanId = newId('vslaloan');
    // The ledger key derives from the CLIENT key — never a per-call id — so
    // a retry of the same logical disbursement replays instead of reposting.
    const ledgerKey = `vsla-loan-issue:${input.idempotencyKey}`;
    let prepared: PreparedLedgerPost | undefined;
    let record: VslaLoanRecord;
    try {
      record = await this.loans.withLoanTransaction(groupId, async (tx) => {
        const posted = await this.ledger.postEntryInTx(
          tx,
          {
            idempotencyKey: ledgerKey,
            referenceType: 'vsla_loan',
            referenceId: loanId,
            description: `VSLA internal loan ${loanId} group ${groupId}`,
            postings,
            // Never-negative: the pool cannot lend cash it does not hold.
            requireSolventAccounts: [groupCashAccountCode(groupId)]
          },
          actor.id
        );
        if (posted.replayed && !this.entryMatchesLoanIssue(posted.entry, totalKobo)) {
          // Fail closed: the client key already funded a DIFFERENT loan
          // payload — never bind this loan row to someone else's posting.
          throw new ConflictException(
            `Idempotency key '${input.idempotencyKey}' was already used for a different loan payload`
          );
        }
        prepared = posted;
        return this.loans.create(
          {
            id: loanId,
            groupId,
            cycleId: cycle.id,
            memberId: member.id,
            principalKobo: input.principalKobo,
            interestRateBps: input.interestRateBps,
            totalDueKobo: totalKobo,
            repaidKobo: 0,
            status: 'ACTIVE',
            issuedAt: new Date().toISOString(),
            ledgerEntryId: posted.entry.id,
            idempotencyKey: input.idempotencyKey,
            createdAt: new Date().toISOString()
          },
          tx
        );
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        // Adopt-on-23505: a concurrent twin with the same client key
        // committed its loan first (pg rolled OUR unit back). Replay the
        // twin when the payload matches; 409 when it does not.
        const twin = await this.loans.findByIdempotencyKey(input.idempotencyKey);
        if (twin) {
          return this.assertLoanIssuePayload(twin, groupId, member.id, input);
        }
      }
      throw error;
    }
    if (prepared) {
      await this.ledger.finalizePostedEntry(prepared, actor.id);
    }
    await this.events.publish('vslacarbon.loan.issued', { groupId, loanId }, actor.id);
    return record;
  }

  /** Same-key replay guard: identical payload replays, anything else 409s. */
  private assertLoanIssuePayload(
    record: VslaLoanRecord,
    groupId: string,
    memberId: string,
    input: IssueLoanInput
  ): VslaLoanRecord {
    if (
      record.groupId !== groupId ||
      record.memberId !== memberId ||
      record.principalKobo !== input.principalKobo ||
      record.interestRateBps !== input.interestRateBps
    ) {
      throw new ConflictException(
        `Idempotency key '${input.idempotencyKey}' was already used for a different loan payload`
      );
    }
    return record;
  }

  /** Defense for an adopted entry: the receivable debit leg equals total due. */
  private entryMatchesLoanIssue(entry: LedgerJournalEntry, totalKobo: number): boolean {
    return entry.postings.find((posting) => posting.direction === 'debit')?.amountKobo === totalKobo;
  }

  async listLoans(actor: User, groupId: string): Promise<VslaLoanRecord[]> {
    await this.assertGroupReader(actor, groupId);
    return this.loans.find({ groupId });
  }

  async getLoan(id: string): Promise<VslaLoanRecord> {
    const loan = await this.loans.findById(id);
    if (!loan) {
      throw new NotFoundException(`VSLA loan '${id}' not found`);
    }
    return loan;
  }

  /**
   * Records a loan repayment. Atomic fold (WP-G1, stage-27 V2 audit): the
   * claim UPDATE, the ledger posting and the repayment row commit in ONE
   * caller-owned transaction (pg) — a crash between them can no longer
   * leave the loan marked REPAID with no money moved (the phantom-claim
   * gap). On the in-memory path the per-loan mutex serialises the same
   * steps and failure compensation keeps the old claim-rollback doctrine.
   * Legacy pre-fold crash states are repaired by reconcileRepaymentClaims
   * and the prior-entry resume below.
   */
  async repayLoan(
    actor: User,
    loanId: string,
    input: RepaymentInput
  ): Promise<{ loan: VslaLoanRecord; repayment: VslaLoanRepaymentRecord }> {
    const loan = await this.getLoan(loanId);
    assertPositiveKobo(input.amountKobo);
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required');
    }
    const member = await this.members.findById(loan.memberId);
    if (member && member.userId !== actor.id && !isGroupAdmin(actor, await this.getGroup(loan.groupId))) {
      throw new ForbiddenException('Only the borrower or a group admin may record repayments');
    }
    // Canonical payload fingerprint (V-57, WP-G11 doctrine): stored with the
    // repayment row so the same key with a DIFFERENT amount is a 409 instead
    // of a silent replay of the original payment.
    const payloadHash = hashIdempotencyPayload({ loanId, amountKobo: input.amountKobo });
    const replay = await this.repayments.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      assertSameIdempotencyPayload(replay.idempotencyKey, replay.payloadHash, payloadHash);
      return { loan: await this.getLoan(loanId), repayment: replay };
    }
    const ledgerKey = `vsla-loan-repayment:${input.idempotencyKey}`;

    // Crashed-saga / same-key-twin resume (pre-fold legacy): if the ledger
    // entry for this client key already exists, the earlier attempt already
    // reserved the amount on the loan row — adopt the entry and only
    // materialise the missing repayment row. Claiming again here would
    // double-credit the loan for one payment.
    const priorEntry = await this.ledger.findEntryByIdempotencyKey(ledgerKey);
    if (priorEntry) {
      if (this.entryAmountKobo(priorEntry) !== input.amountKobo) {
        // Fail closed: the client key already posted a DIFFERENT amount.
        throw new ConflictException(
          `Idempotency key '${input.idempotencyKey}' was already used for a different repayment amount`
        );
      }
      const repayment = await this.materialiseRepaymentRow(
        loanId,
        input.idempotencyKey,
        priorEntry,
        payloadHash
      );
      return { loan: await this.getLoan(loanId), repayment };
    }

    if (loan.status === 'REPAID') {
      throw new ConflictException('Loan is already fully repaid');
    }
    if (loan.status === 'WRITTEN_OFF') {
      throw new ConflictException('Loan has been written off and no longer accepts repayments');
    }

    // V-57: never silently clamp an overpayment — the excess kobo would move
    // without a book entry. Reject so the caller resubmits the exact
    // outstanding amount (an explicit excess-to-savings leg may be added
    // later if product wants one).
    const outstanding = loan.totalDueKobo - loan.repaidKobo;
    if (input.amountKobo > outstanding) {
      throw new BadRequestException(
        `Repayment of ${input.amountKobo} kobo exceeds the outstanding balance of ${outstanding} kobo`
      );
    }
    const amountKobo = input.amountKobo;

    let claimed = false;
    let postedDurable = false;
    let inMemoryUnit = false;
    let prepared: PreparedLedgerPost | undefined;
    let repayment: VslaLoanRepaymentRecord;
    try {
      repayment = await this.loans.withLoanTransaction(loanId, async (tx) => {
        inMemoryUnit = tx === undefined;
        // Claim-first (stage-24 audit A1-4/A4-5): atomically reserve the
        // repayment on the loan row BEFORE any money movement. The guarded
        // UPDATE serializes concurrent repayments on the loan row — a loser
        // whose payment would overshoot total_due_kobo updates zero rows and
        // 409s here, before its kobo ever reaches the ledger. With the WP-G1
        // fold the claim now commits WITH the posting and the row.
        const claim = await this.loans.claimRepayment(loanId, amountKobo, tx);
        if (!claim) {
          throw new ConflictException(
            `VSLA loan '${loanId}' cannot accept this repayment (changed concurrently or already settled); reload and retry`
          );
        }
        claimed = true;
        const posted = await this.ledger.postEntryInTx(
          tx,
          {
            idempotencyKey: ledgerKey,
            referenceType: 'vsla_loan_repayment',
            referenceId: loanId,
            description: `VSLA loan repayment ${loanId}`,
            postings: [
              {
                accountCode: groupCashAccountCode(loan.groupId),
                direction: 'debit',
                amountKobo
              },
              {
                accountCode: groupLoansReceivableAccountCode(loan.groupId),
                direction: 'credit',
                amountKobo
              }
            ],
            // Never-negative: repayments cannot exceed the receivable balance.
            requireSolventAccounts: [groupLoansReceivableAccountCode(loan.groupId)]
          },
          actor.id
        );
        if (posted.replayed && this.entryAmountKobo(posted.entry) !== amountKobo) {
          // Fail closed: the client key already posted a DIFFERENT amount —
          // a 409 here rolls our claim back with the unit (pg) or triggers
          // the compensation below (in-memory).
          throw new ConflictException(
            `Idempotency key '${input.idempotencyKey}' was already used for a different repayment amount`
          );
        }
        prepared = posted;
        // On the in-memory path the entry is already durable at this point;
        // on pg nothing is durable until the unit commits.
        postedDurable = tx === undefined;
        return this.repayments.create(
          {
            id: newId('vslarepay'),
            loanId,
            // The entry is the money truth: the row records what actually posted.
            amountKobo: this.entryAmountKobo(posted.entry),
            idempotencyKey: input.idempotencyKey,
            ledgerEntryId: posted.entry.id,
            payloadHash,
            createdAt: new Date().toISOString()
          },
          tx
        );
      });
    } catch (error) {
      // pg: the whole unit (claim + posting + row) already rolled back — no
      // compensation needed or allowed. In-memory: release the claim when it
      // stands without a committed entry, or when a twin owns the key.
      if (
        inMemoryUnit &&
        claimed &&
        (!postedDurable || error instanceof ConflictException)
      ) {
        await this.loans.rollbackRepaymentClaim(loanId, amountKobo);
      }
      if (error instanceof ConflictException) {
        // Adopt-on-conflict: a twin with the same client key committed the
        // whole unit first — replay its outcome instead of surfacing a 409
        // for a retry of the same logical payment.
        const twin = await this.repayments.findByIdempotencyKey(input.idempotencyKey);
        if (twin) {
          assertSameIdempotencyPayload(twin.idempotencyKey, twin.payloadHash, payloadHash);
          return { loan: await this.getLoan(loanId), repayment: twin };
        }
      }
      // Non-conflict failure AFTER the entry committed (in-memory only):
      // the claim was deliberately left standing — it matches the committed
      // entry, and a same-key retry resumes through the prior-entry path
      // above to materialise the row.
      throw error;
    }
    if (prepared) {
      await this.ledger.finalizePostedEntry(prepared, actor.id);
    }
    await this.events.publish('vslacarbon.loan.repayment_recorded', { loanId }, actor.id);
    return { loan: await this.getLoan(loanId), repayment };
  }

  /**
   * Materialises the repayment row for an entry that already committed under
   * the client key (crashed-saga resume). Adopts a racing twin's row on
   * conflict. Never claims: the claim matching this entry already stands.
   */
  /**
   * V-10: explicit loss recognition — a group admin writes off a DEFAULTED
   * loan, moving the outstanding claim from loans_receivable to a bad-debt
   * EXPENSE so the books stop pretending the money is recoverable. The entry
   * is entity-keyed (`vsla-writeoff:{loanId}`) so a replay adopts it; the
   * DEFAULTED→WRITTEN_OFF transition is a CAS. Written-off loans are excluded
   * from share-out arrears netting (the claim is extinguished).
   */
  async writeOffLoan(actor: User, loanId: string): Promise<VslaLoanRecord> {
    const loan = await this.getLoan(loanId);
    const group = await this.getGroup(loan.groupId);
    requireGroupAdmin(actor, group);
    if (loan.status === 'WRITTEN_OFF') {
      return loan; // replay-safe
    }
    if (loan.status !== 'DEFAULTED') {
      throw new ConflictException('Only a DEFAULTED loan can be written off');
    }
    const outstandingKobo = loan.totalDueKobo - loan.repaidKobo;
    if (outstandingKobo > 0) {
      await this.ledger.ensureAccount({
        code: groupBadDebtAccountCode(loan.groupId),
        type: 'expense',
        ownerId: actor.id
      });
      await this.ledger.postEntry(
        {
          idempotencyKey: `vsla-writeoff:${loanId}`,
          referenceType: 'vsla_loan_writeoff',
          referenceId: loanId,
          description: `VSLA loan write-off ${loanId} (bad debt)`,
          postings: [
            {
              accountCode: groupBadDebtAccountCode(loan.groupId),
              direction: 'debit',
              amountKobo: outstandingKobo
            },
            {
              accountCode: groupLoansReceivableAccountCode(loan.groupId),
              direction: 'credit',
              amountKobo: outstandingKobo
            }
          ],
          requireSolventAccounts: [groupLoansReceivableAccountCode(loan.groupId)]
        },
        actor.id
      );
    }
    const writtenOff = await this.loans.updateExpected(
      loanId,
      { status: 'WRITTEN_OFF' },
      { status: 'DEFAULTED' }
    );
    await this.events.publish(
      'vslacarbon.loan.written_off',
      { groupId: loan.groupId, loanId, outstandingKobo },
      actor.id
    );
    return writtenOff;
  }

  private async materialiseRepaymentRow(
    loanId: string,
    idempotencyKey: string,
    entry: LedgerJournalEntry,
    payloadHash?: string
  ): Promise<VslaLoanRepaymentRecord> {
    try {
      return await this.repayments.create({
        id: newId('vslarepay'),
        loanId,
        // The entry is the money truth: the row records what actually posted.
        amountKobo: this.entryAmountKobo(entry),
        idempotencyKey,
        ledgerEntryId: entry.id,
        payloadHash,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        const twin = await this.repayments.findByIdempotencyKey(idempotencyKey);
        if (twin) {
          return twin;
        }
      }
      throw error;
    }
  }

  /**
   * Reconciler sweep (WP-G1, stage-27 V2 audit — phantom repayment claims):
   * repairs loans whose repaid_kobo diverges from the committed money truth.
   * For each divergent loan, repayment rows are materialised for entries
   * that committed without one (re-drive), and any remaining claim NOT
   * backed by a ledger entry is released (a phantom claim left by a pre-fold
   * crash — the borrower never actually paid it, so the loan must not stay
   * REPAID/409-locked). With the folded write path a claim, its entry and
   * its row commit atomically, so a divergent loan is always legacy or
   * corrupt state. Run when no repayments are in flight (scheduler wiring:
   * WP-G12). Returns the corrections applied.
   */
  async reconcileRepaymentClaims(): Promise<
    Array<{ loanId: string; materialisedRows: number; releasedKobo: number }>
  > {
    const corrections: Array<{ loanId: string; materialisedRows: number; releasedKobo: number }> =
      [];
    const loans = await this.loans.find({});
    for (const loan of loans) {
      const rows = await this.repayments.findByLoan(loan.id);
      const recordedKobo = rows.reduce((sum, row) => sum + row.amountKobo, 0);
      if (recordedKobo === loan.repaidKobo) {
        continue; // loan aggregate and money truth agree
      }
      const entries = await this.ledger.listEntries({
        referenceType: 'vsla_loan_repayment',
        referenceId: loan.id
      });
      // Re-drive: every committed repayment entry must have its row.
      const rowedEntryIds = new Set(rows.map((row) => row.ledgerEntryId));
      let materialisedRows = 0;
      for (const entry of entries) {
        if (rowedEntryIds.has(entry.id)) {
          continue;
        }
        const clientKey = entry.idempotencyKey.replace(/^vsla-loan-repayment:/, '');
        try {
          await this.repayments.create({
            id: newId('vslarepay'),
            loanId: loan.id,
            amountKobo: this.entryAmountKobo(entry),
            idempotencyKey: clientKey,
            ledgerEntryId: entry.id,
            createdAt: entry.postedAt
          });
          materialisedRows += 1;
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          // A concurrent resume already materialised the row.
        }
      }
      // Release: a claim no committed entry backs is a phantom — the money
      // never moved, so the loan aggregate must give it back.
      const postedKobo = entries.reduce((sum, entry) => sum + this.entryAmountKobo(entry), 0);
      const phantomKobo = loan.repaidKobo - postedKobo;
      let releasedKobo = 0;
      if (phantomKobo > 0) {
        await this.loans.rollbackRepaymentClaim(loan.id, phantomKobo);
        releasedKobo = phantomKobo;
        // rollbackRepaymentClaim unconditionally re-opens the loan; when the
        // committed entries still cover the full total, restore REPAID.
        const after = await this.loans.findById(loan.id);
        if (after && after.status === 'ACTIVE' && after.repaidKobo >= after.totalDueKobo) {
          await this.loans.updateExpected(
            after.id,
            { status: 'REPAID', repaidAt: new Date().toISOString() },
            { status: 'ACTIVE' }
          );
        }
      }
      if (materialisedRows > 0 || releasedKobo > 0) {
        corrections.push({ loanId: loan.id, materialisedRows, releasedKobo });
      }
    }
    return corrections;
  }

  /** Amount posted by a repayment entry (the group-cash debit leg). */
  private entryAmountKobo(entry: LedgerJournalEntry): number {
    return entry.postings.find((posting) => posting.direction === 'debit')?.amountKobo ?? 0;
  }

  async listRepayments(actor: User, loanId: string): Promise<VslaLoanRepaymentRecord[]> {
    const loan = await this.getLoan(loanId);
    await this.assertGroupReader(actor, loan.groupId);
    return this.repayments.findByLoan(loanId);
  }

  // -------------------------------------------------------- carbon plots

  async registerPlot(actor: User, input: RegisterPlotInput): Promise<VslaCarbonPlotRecord> {
    const group = await this.getGroup(input.groupId);
    const ownerUserId = input.ownerUserId ?? actor.id;
    if (!isGroupAdmin(actor, group)) {
      // Farmers register their own plot only, and must be an active member.
      const membership = await this.members.findByGroupAndUser(input.groupId, actor.id);
      if (!membership || membership.status !== 'ACTIVE' || ownerUserId !== actor.id) {
        throw new ForbiddenException(
          'Only group admins, or an active member registering their own plot, may register plots'
        );
      }
    }
    if (!input.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!Number.isFinite(input.hectares) || input.hectares <= 0 || input.hectares > 100_000) {
      throw new BadRequestException('hectares must be a positive number');
    }
    const hectaresCenti = Math.round(input.hectares * 100);
    if (hectaresCenti <= 0) {
      throw new BadRequestException('hectares is below the 0.01 ha resolution');
    }
    const h3Res9 = this.h3.cellAt(input.centroidLat, input.centroidLong, CARBON_PLOT_H3_RESOLUTION);
    const record = await this.plots.create({
      id: newId('carbonplot'),
      groupId: input.groupId,
      ownerUserId,
      name: input.name.trim(),
      practiceType: input.practiceType,
      hectaresCenti,
      centroidLat: input.centroidLat,
      centroidLong: input.centroidLong,
      h3Res9,
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'vslacarbon.plot.registered',
      { groupId: input.groupId, plotId: record.id, h3Res9 },
      actor.id
    );
    return record;
  }

  /**
   * Plot listing (V-13): privileged readers (admin/regulator) see all plots
   * (optionally group-filtered); everyone else sees ONLY their own plots, and
   * a group filter additionally requires active membership of that group.
   */
  async listPlots(actor: User, groupId?: string): Promise<VslaCarbonPlotRecord[]> {
    if (isPrivilegedReader(actor)) {
      return this.plots.find(groupId ? { groupId } : {});
    }
    if (groupId) {
      await this.assertGroupReader(actor, groupId);
      return this.plots.find({ groupId, ownerUserId: actor.id });
    }
    return this.plots.find({ ownerUserId: actor.id });
  }

  async getPlot(id: string): Promise<VslaCarbonPlotRecord> {
    const plot = await this.plots.findById(id);
    if (!plot) {
      throw new NotFoundException(`Carbon plot '${id}' not found`);
    }
    return plot;
  }

  /** Plot detail for an authenticated caller, membership-scoped (V-13). */
  async readPlot(actor: User, id: string): Promise<VslaCarbonPlotRecord> {
    const plot = await this.getPlot(id);
    await this.assertGroupReader(actor, plot.groupId);
    return plot;
  }

  // ----------------------------------------------------- carbon evidence

  async submitEvidence(
    actor: User,
    plotId: string,
    input: SubmitEvidenceInput
  ): Promise<CarbonEvidenceRecord> {
    const plot = await this.getPlot(plotId);
    assertSeason(input.season);
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required');
    }
    if (
      input.survivalRatePct !== undefined &&
      (!Number.isSafeInteger(input.survivalRatePct) ||
        input.survivalRatePct < 0 ||
        input.survivalRatePct > 100)
    ) {
      throw new BadRequestException('survivalRatePct must be an integer between 0 and 100');
    }
    const isEnumerator = actor.roles.includes('enumerator');
    const isOwner = plot.ownerUserId === actor.id;
    if (!isEnumerator && !isOwner) {
      const membership = await this.members.findByGroupAndUser(plot.groupId, actor.id);
      if (!membership || membership.status !== 'ACTIVE') {
        throw new ForbiddenException(
          'Only the plot owner, a group member or an enumerator may submit evidence'
        );
      }
    }
    const replay = await this.evidence.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay;
    }
    let ndviLink: Pick<
      CarbonEvidenceRecord,
      'ndviHealthScore' | 'ndviClassification' | 'ndviBasis'
    > = {};
    if (input.linkNdvi) {
      // FAIL-CLOSED (WP-G15, mirrors the geo-intel stub guard): the stub
      // NDVI provider returns a deterministic FABRICATED fixture — persisting
      // it on a carbon evidence record in production would contaminate MRV /
      // donor reporting with stub-derived values. Refuse before ANY write;
      // resubmit without linkNdvi or wire CROP_ML_DRIVER=http + CROP_ML_URL.
      if (isProduction() && this.ndvi.name === 'stub') {
        throw new ServiceUnavailableException(
          'NDVI evidence linkage requires the live crop-ml sidecar in production ' +
            '(CROP_ML_DRIVER=http + CROP_ML_URL); the stub provider would persist fabricated ' +
            'fixture values on a carbon evidence record. Evidence was NOT recorded.'
        );
      }
      try {
        const assessment = await this.ndvi.assess({ plotId, season: input.season });
        ndviLink = {
          ndviHealthScore: assessment.healthScore,
          ndviClassification: assessment.classification,
          // Stored verbatim — stub evidence is never upgraded to 'live'.
          ndviBasis: assessment.basis
        };
      } catch (error) {
        if (isNdviProviderError(error)) {
          // FAIL-CLOSED: live provider configured but unreachable → 503.
          throw new ServiceUnavailableException(
            'NDVI provider unavailable — evidence was not recorded; retry later or resubmit without linkNdvi'
          );
        }
        throw error;
      }
    }
    const record = await this.evidence.create({
      id: newId('carbonevidence'),
      plotId,
      groupId: plot.groupId,
      season: input.season,
      submittedBy: actor.id,
      submitterRole: isEnumerator && !isOwner ? 'enumerator' : 'farmer',
      survivalRatePct: input.survivalRatePct,
      notes: input.notes,
      ...ndviLink,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'vslacarbon.evidence.submitted',
      { plotId, evidenceId: record.id, season: input.season },
      actor.id
    );
    return record;
  }

  async listEvidence(actor: User, plotId: string): Promise<CarbonEvidenceRecord[]> {
    const plot = await this.getPlot(plotId);
    await this.assertGroupReader(actor, plot.groupId);
    return this.evidence.find({ plotId });
  }

  // ---------------------------------------------------- carbon estimates

  /**
   * Compute + persist a deterministic ESTIMATE for a plot/season from the
   * versioned coefficient table. Idempotent: the same (plot, season,
   * version) replays the stored figure. Survival defaults to the latest
   * observed evidence (season-first), 100 when no evidence exists.
   */
  async estimatePlot(actor: User, plotId: string, season: string): Promise<CarbonEstimateRecord> {
    const plot = await this.getPlot(plotId);
    assertSeason(season);
    const isAdmin =
      isGroupAdmin(actor, await this.getGroup(plot.groupId)) || actor.roles.includes('enumerator');
    if (!isAdmin && plot.ownerUserId !== actor.id) {
      throw new ForbiddenException('Only the plot owner, an enumerator or a group admin may estimate');
    }
    const existing = await this.estimates.findByPlotSeasonVersion(
      plotId,
      season,
      CO2E_COEFFICIENT_VERSION
    );
    if (existing) {
      return existing;
    }
    const plotEvidence = await this.evidence.find({ plotId });
    const withSurvival = plotEvidence.filter((row) => row.survivalRatePct !== undefined);
    const seasonRows = withSurvival.filter((row) => row.season === season);
    const survivalSource = seasonRows[seasonRows.length - 1] ?? withSurvival[withSurvival.length - 1];
    const survivalRatePct = survivalSource?.survivalRatePct ?? 100;
    const seasonCount = Math.max(1, new Set(plotEvidence.map((row) => row.season)).size);
    const co2eMilliTonnes = computeCo2eEstimateMilliTonnes({
      hectaresCenti: plot.hectaresCenti,
      practiceType: plot.practiceType,
      survivalRatePct,
      seasonCount
    });
    const record = await this.estimates.create({
      id: newId('carbonestimate'),
      plotId,
      groupId: plot.groupId,
      season,
      coefficientVersion: CO2E_COEFFICIENT_VERSION,
      hectaresCenti: plot.hectaresCenti,
      practiceType: plot.practiceType,
      survivalRatePct,
      seasonCount,
      co2eMilliTonnes,
      basis: 'estimate',
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'vslacarbon.estimate.recorded',
      { plotId, estimateId: record.id, season },
      actor.id
    );
    return record;
  }

  async listEstimates(actor: User, plotId: string): Promise<CarbonEstimateRecord[]> {
    const plot = await this.getPlot(plotId);
    await this.assertGroupReader(actor, plot.groupId);
    return this.estimates.find({ plotId });
  }

  listCoefficients(): { version: string; coefficients: readonly CarbonCoefficient[] } {
    return { version: CO2E_COEFFICIENT_VERSION, coefficients: CARBON_COEFFICIENTS };
  }

  async ndviStatus(): Promise<ReturnType<NdviProvider['status']>> {
    return this.ndvi.status();
  }

  // -------------------------------------------------------- MRV reports

  async groupMrvReport(groupId: string): Promise<GroupMrvReport> {
    const group = await this.getGroup(groupId);
    return this.buildGroupReport(group);
  }

  async programmeMrvReport(): Promise<ProgrammeMrvReport> {
    const groups = await this.groups.find({});
    const rows: GroupMrvReport[] = [];
    for (const group of groups) {
      rows.push(await this.buildGroupReport(group));
    }
    const hectaresCenti = rows.reduce(
      (sum, row) => sum + Math.round(row.hectaresUnderPractice * 100),
      0
    );
    const survivals = rows
      .map((row) => row.meanSurvivalRatePct)
      .filter((value): value is number => value !== null);
    const usesStub = rows.some((row) => row.basisFlags.includes('stub'));
    return {
      groupCount: rows.length,
      plotCount: rows.reduce((sum, row) => sum + row.plotCount, 0),
      hectaresUnderPractice: hectaresCenti / 100,
      meanSurvivalRatePct:
        survivals.length > 0
          ? Math.round(survivals.reduce((sum, value) => sum + value, 0) / survivals.length)
          : null,
      estimatedCo2eTonnes:
        Math.round(rows.reduce((sum, row) => sum + row.estimatedCo2eTonnes * 1000, 0)) / 1000,
      estimateCount: rows.reduce((sum, row) => sum + row.estimateCount, 0),
      evidenceCount: rows.reduce((sum, row) => sum + row.evidenceCount, 0),
      ndviLinkedEvidenceCount: rows.reduce((sum, row) => sum + row.ndviLinkedEvidenceCount, 0),
      basisFlags: usesStub ? ['stub', 'estimate'] : ['estimate'],
      disclaimer: ESTIMATE_DISCLAIMER,
      groups: rows,
      generatedAt: new Date().toISOString()
    };
  }

  private async buildGroupReport(group: VslaGroupRecord): Promise<GroupMrvReport> {
    const plots = await this.plots.find({ groupId: group.id, status: 'ACTIVE' });
    const estimates = await this.estimates.find({ groupId: group.id });
    const evidence = await this.evidence.find({ groupId: group.id });
    const latestSurvival = new Map<string, number>();
    for (const row of evidence) {
      if (row.survivalRatePct !== undefined) {
        latestSurvival.set(row.plotId, row.survivalRatePct);
      }
    }
    const survivals = [...latestSurvival.values()];
    const hectaresCenti = plots.reduce((sum, plot) => sum + plot.hectaresCenti, 0);
    const co2eMilli = estimates.reduce((sum, estimate) => sum + estimate.co2eMilliTonnes, 0);
    const ndviLinked = evidence.filter((row) => row.ndviBasis !== undefined);
    const usesStub = ndviLinked.some((row) => row.ndviBasis === 'stub');
    return {
      groupId: group.id,
      groupName: group.name,
      plotCount: plots.length,
      hectaresUnderPractice: hectaresCenti / 100,
      meanSurvivalRatePct:
        survivals.length > 0
          ? Math.round(survivals.reduce((sum, value) => sum + value, 0) / survivals.length)
          : null,
      estimatedCo2eTonnes: Math.round(co2eMilli) / 1000,
      estimateCount: estimates.length,
      evidenceCount: evidence.length,
      ndviLinkedEvidenceCount: ndviLinked.length,
      basisFlags: usesStub ? ['stub', 'estimate'] : ['estimate'],
      disclaimer: ESTIMATE_DISCLAIMER
    };
  }

  // ----------------------------------------------------------- internals

  private async requireActiveMember(groupId: string, memberId: string): Promise<VslaMemberRecord> {
    const member = await this.members.findById(memberId);
    if (!member || member.groupId !== groupId) {
      throw new NotFoundException(`Member '${memberId}' not found in group '${groupId}'`);
    }
    if (member.status !== 'ACTIVE') {
      throw new ConflictException(`Member '${memberId}' is no longer active in the group`);
    }
    return member;
  }
}
