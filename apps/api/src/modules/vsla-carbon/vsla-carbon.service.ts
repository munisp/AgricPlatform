import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
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
  VSLA_MEMBER_REPOSITORY,
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
  VslaMemberRecord,
  VslaMemberRepository,
  VslaMemberRole,
  VslaShareOutRecord,
  VslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
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
    @Inject(CHAPTER_REPOSITORY) private readonly chapters?: ChapterRepository
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

  async addMember(actor: User, groupId: string, input: AddMemberInput): Promise<VslaMemberRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group);
    const existing = await this.members.findByGroupAndUser(groupId, input.userId);
    if (existing) {
      return existing; // idempotent re-join
    }
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

  async listMembers(groupId: string): Promise<VslaMemberRecord[]> {
    await this.getGroup(groupId);
    return this.members.find({ groupId });
  }

  // ------------------------------------------------------------ cycles

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

  async listCycles(groupId: string): Promise<VslaCycleRecord[]> {
    await this.getGroup(groupId);
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
    // Idempotent replay: the same client key returns the original record.
    const replay = await this.contributions.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay;
    }
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
    const record = await this.contributions.create({
      id: newId('vslacontrib'),
      cycleId,
      groupId: cycle.groupId,
      memberId: member.id,
      amountKobo: input.amountKobo,
      idempotencyKey: input.idempotencyKey,
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'vslacarbon.contribution.recorded',
      { cycleId, contributionId: record.id },
      actor.id
    );
    return record;
  }

  async listContributions(cycleId: string): Promise<VslaContributionRecord[]> {
    await this.getCycle(cycleId);
    return this.contributions.find({ cycleId });
  }

  /**
   * Close a cycle and run the deterministic pro-rata share-out. CAS on
   * OPEN→CLOSED elects a single closer; replays (and retried closes after a
   * partial post) re-post idempotently via the ledger/share-out unique keys
   * and return the same report.
   */
  async closeCycle(actor: User, cycleId: string): Promise<ShareOutReport> {
    const cycle = await this.getCycle(cycleId);
    const group = await this.getGroup(cycle.groupId);
    requireGroupAdmin(actor, group);
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

    const cycleContributions = await this.contributions.find({ cycleId });
    const memberIds = [...new Set(cycleContributions.map((row) => row.memberId))];
    const memberRows: Array<{ member: VslaMemberRecord; contributedKobo: number }> = [];
    for (const memberId of memberIds) {
      const member = await this.members.findById(memberId);
      if (!member) continue;
      const contributedKobo = cycleContributions
        .filter((row) => row.memberId === memberId)
        .reduce((sum, row) => sum + row.amountKobo, 0);
      memberRows.push({ member, contributedKobo });
    }

    // The distributable pool is the pooled-cash ledger balance — the ledger
    // is the source of truth for money, the tables only record the outcome.
    const { balanceKobo: distributableKobo } = await this.ledger.balance(
      groupCashAccountCode(cycle.groupId)
    );
    const payouts = computeShareOut(
      memberRows.map((row) => ({
        memberId: row.member.id,
        contributedKobo: row.contributedKobo
      })),
      Math.max(0, distributableKobo)
    );

    const records: VslaShareOutRecord[] = [];
    for (const payout of payouts) {
      const existing = (await this.shareOuts.find({ cycleId, memberId: payout.memberId }))[0];
      if (existing) {
        records.push(existing);
        continue;
      }
      const member = memberRows.find((row) => row.member.id === payout.memberId);
      if (!member) continue;
      let entryId = '';
      if (payout.shareKobo > 0) {
        const memberDebit = Math.min(payout.shareKobo, payout.contributedKobo);
        const surplusDebit = payout.shareKobo - memberDebit;
        const postings = [
          {
            accountCode: memberSavingsAccountCode(cycle.groupId, member.member.userId),
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
            amountKobo: payout.shareKobo
          }
        ].filter((posting) => posting.amountKobo > 0);
        const entry = await this.ledger.postEntry(
          {
            idempotencyKey: `vsla-shareout:${cycleId}:${payout.memberId}`,
            referenceType: 'vsla_share_out',
            referenceId: cycleId,
            description: `VSLA share-out cycle ${cycleId} member ${payout.memberId}`,
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
            memberId: payout.memberId,
            shareKobo: payout.shareKobo,
            contributedKobo: payout.contributedKobo,
            residualKobo: payout.residualKobo,
            ledgerEntryId: entryId,
            createdAt: new Date().toISOString()
          })
        );
      } catch (error) {
        if (error instanceof ConflictException) {
          // Concurrent close already recorded this member — reuse their row.
          const concurrent = (await this.shareOuts.find({ cycleId, memberId: payout.memberId }))[0];
          if (concurrent) records.push(concurrent);
          continue;
        }
        throw error;
      }
    }
    await this.events.publish(
      'vslacarbon.cycle.closed',
      { groupId: cycle.groupId, cycleId, distributableKobo },
      actor.id
    );
    // Conservation: the distributable pool always equals the paid-out total.
    // On a replay the ledger balance is already paid out, so the report
    // total comes from the recorded payouts (identical on the first close).
    const reportedDistributable = records.reduce((sum, record) => sum + record.shareKobo, 0);
    return {
      cycleId,
      groupId: cycle.groupId,
      distributableKobo: reportedDistributable,
      payouts: records,
      closedAt: cycle.closedAt ?? new Date().toISOString(),
      replayed
    };
  }

  async getShareOut(cycleId: string): Promise<VslaShareOutRecord[]> {
    await this.getCycle(cycleId);
    return this.shareOuts.find({ cycleId });
  }

  // --------------------------------------------------------------- loans

  async issueLoan(actor: User, groupId: string, input: IssueLoanInput): Promise<VslaLoanRecord> {
    const group = await this.getGroup(groupId);
    requireGroupAdmin(actor, group);
    assertLoanTerms(input.principalKobo, input.interestRateBps);
    const cycle = await this.cycles.findOpenByGroup(groupId);
    if (!cycle) {
      throw new ConflictException('Loans are only issued against an open cycle');
    }
    const member = await this.requireActiveMember(groupId, input.memberId);
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
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `vsla-loan-issue:${loanId}`,
        referenceType: 'vsla_loan',
        referenceId: loanId,
        description: `VSLA internal loan ${loanId} group ${groupId}`,
        postings,
        // Never-negative: the pool cannot lend cash it does not hold.
        requireSolventAccounts: [groupCashAccountCode(groupId)]
      },
      actor.id
    );
    const record = await this.loans.create({
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
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    await this.events.publish('vslacarbon.loan.issued', { groupId, loanId }, actor.id);
    return record;
  }

  async listLoans(groupId: string): Promise<VslaLoanRecord[]> {
    await this.getGroup(groupId);
    return this.loans.find({ groupId });
  }

  async getLoan(id: string): Promise<VslaLoanRecord> {
    const loan = await this.loans.findById(id);
    if (!loan) {
      throw new NotFoundException(`VSLA loan '${id}' not found`);
    }
    return loan;
  }

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
    const replay = await this.repayments.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return { loan: await this.getLoan(loanId), repayment: replay };
    }
    if (loan.status === 'REPAID') {
      throw new ConflictException('Loan is already fully repaid');
    }
    const outstanding = loan.totalDueKobo - loan.repaidKobo;
    const amountKobo = Math.min(input.amountKobo, outstanding);
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `vsla-loan-repayment:${input.idempotencyKey}`,
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
    const repayment = await this.repayments.create({
      id: newId('vslarepay'),
      loanId,
      amountKobo,
      idempotencyKey: input.idempotencyKey,
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    const repaidKobo = loan.repaidKobo + amountKobo;
    const fullyRepaid = repaidKobo >= loan.totalDueKobo;
    const updated = await this.loans.updateExpected(
      loanId,
      {
        repaidKobo,
        ...(fullyRepaid
          ? { status: 'REPAID' as const, repaidAt: new Date().toISOString() }
          : {})
      },
      { repaidKobo: loan.repaidKobo, status: loan.status }
    );
    await this.events.publish('vslacarbon.loan.repayment_recorded', { loanId }, actor.id);
    return { loan: updated, repayment };
  }

  async listRepayments(loanId: string): Promise<VslaLoanRepaymentRecord[]> {
    await this.getLoan(loanId);
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

  async listPlots(groupId?: string): Promise<VslaCarbonPlotRecord[]> {
    return this.plots.find(groupId ? { groupId } : {});
  }

  async getPlot(id: string): Promise<VslaCarbonPlotRecord> {
    const plot = await this.plots.findById(id);
    if (!plot) {
      throw new NotFoundException(`Carbon plot '${id}' not found`);
    }
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

  async listEvidence(plotId: string): Promise<CarbonEvidenceRecord[]> {
    await this.getPlot(plotId);
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

  async listEstimates(plotId: string): Promise<CarbonEstimateRecord[]> {
    await this.getPlot(plotId);
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
