import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
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
  LEDGER_ACCOUNT_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  OUTBOX_REPOSITORY,
  VSLA_CONTRIBUTION_REPOSITORY,
  VSLA_CYCLE_REPOSITORY,
  VSLA_GROUP_REPOSITORY,
  VSLA_LOAN_REPOSITORY,
  VSLA_LOAN_REPAYMENT_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_SHARE_OUT_PLAN_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type {
  LedgerAccountRepository,
  LedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import type { OutboxRepository } from '../../database/repositories/outbox.repository.js';
import type {
  CarbonEvidenceRecord,
  CarbonEvidenceRepository,
  CarbonEstimateRecord,
  CarbonEstimateRepository,
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
  VslaShareOutPlanRecord,
  VslaShareOutPlanRepository,
  VslaShareOutRecord,
  VslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { computeCo2eEstimateMilliTonnes, type CarbonCoefficient } from './carbon-coefficients.js';
import { CARBON_COEFFICIENTS, CO2E_COEFFICIENT_VERSION } from './carbon-coefficients.js';
import {
  isNdviProviderError,
  NDVI_PROVIDER,
  type NdviProvider
} from './ndvi.provider.js';

/** Simple-interest bounds for internal VSLA loans (basis points). */
const MIN_LOAN_INTEREST_BPS = 0;
const MAX_LOAN_INTEREST_BPS = 10_000;

export const ESTIMATE_DISCLAIMER =
  'Deterministic estimate from the versioned coefficient table — NOT verification-grade carbon credits.';

/** Ledger account codes (deterministic, unique per group/member). */
export function groupCashAccountCode(groupId: string): string {
  return `vsla:${groupId}:cash`;
}

export function memberSavingsAccountCode(groupId: string, userId: string): string {
  return `vsla:${groupId}:member:${userId}:savings`;
}

export interface CreateGroupInput {
  name: string;
  chapterId?: string;
}

export interface AddMemberInput {
  userId: string;
  role?: 'member' | 'lead';
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
  idempotencyKey: string;
}

export interface RepayLoanInput {
  amountKobo: number;
  idempotencyKey: string;
}

export interface RegisterPlotInput {
  ownerUserId: string;
  name: string;
  practiceType: CarbonPracticeType;
  hectares: number;
  centroidLat: number;
  centroidLong: number;
}

export interface SubmitEvidenceInput {
  season: string;
  survivalRatePct?: number;
  notes?: string;
  linkNdvi?: boolean;
  idempotencyKey: string;
}

export interface GroupMrvReport {
  groupId: string;
  groupName: string;
  plotCount: number;
  hectaresUnderPractice: number;
  meanSurvivalRatePct: number | null;
  estimatedCo2eTonnes: number;
  estimateCount: number;
  evidenceCount: number;
  ndviLinkedEvidenceCount: number;
  basisFlags: readonly ('stub' | 'estimate' | 'live')[];
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
  basisFlags: readonly ('stub' | 'estimate' | 'live')[];
  disclaimer: string;
  groups: GroupMrvReport[];
  generatedAt: string;
}

function assertPositiveKobo(amountKobo: number, field = 'amountKobo'): void {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new BadRequestException(`${field} must be a positive integer number of kobo`);
  }
}

function assertSeason(season: string): void {
  if (!/^\d{4}-(wet|dry)$/.test(season)) {
    throw new BadRequestException("season must look like '2026-wet' or '2026-dry'");
  }
}

function isGroupAdmin(actor: User, group: VslaGroupRecord): boolean {
  return actor.roles.includes('admin') || group.leadUserId === actor.id;
}

/**
 * VSLA (savings-group) and carbon-MRV application service (wave VSLACARBON).
 *
 * Money doctrine: every contribution, loan disbursement/repayment and the
 * share-out at cycle close posts a balanced double-entry journal through the
 * finance ledger BEFORE the operational row is persisted; operational rows
 * carry ledgerEntryId. The ledger's own idempotency keys are derived from
 * the client keys, so retries never double-post. Internal loans are simple
 * interest (integer bps, integer kobo) — no compounding, no float money.
 */
@Injectable()
export class VslaCarbonService {
  constructor(
    @Inject(VSLA_GROUP_REPOSITORY) private readonly groups: VslaGroupRepository,
    @Inject(VSLA_MEMBER_REPOSITORY) private readonly members: VslaMemberRepository,
    @Inject(VSLA_CYCLE_REPOSITORY) private readonly cycles: VslaCycleRepository,
    @Inject(VSLA_CONTRIBUTION_REPOSITORY)
    private readonly contributions: VslaContributionRepository,
    @Inject(VSLA_SHARE_OUT_REPOSITORY) private readonly shareOuts: VslaShareOutRepository,
    @Inject(VSLA_SHARE_OUT_PLAN_REPOSITORY)
    private readonly shareOutPlans: VslaShareOutPlanRepository,
    @Inject(VSLA_LOAN_REPOSITORY) private readonly loans: VslaLoanRepository,
    @Inject(VSLA_LOAN_REPAYMENT_REPOSITORY)
    private readonly loanRepayments: VslaLoanRepaymentRepository,
    @Inject(CARBON_PLOT_REPOSITORY) private readonly plots: CarbonPlotRepository,
    @Inject(CARBON_EVIDENCE_REPOSITORY) private readonly evidence: CarbonEvidenceRepository,
    @Inject(CARBON_ESTIMATE_REPOSITORY) private readonly estimates: CarbonEstimateRepository,
    private readonly ledger: LedgerService,
    private readonly h3: H3Service,
    private readonly events: DomainEventsService,
    // Optional so bare service constructions in tests keep working; always
    // wired in the Nest module.
    @Optional() @Inject(NDVI_PROVIDER) private readonly ndvi?: NdviProvider,
    @Optional() @Inject(CHAPTER_REPOSITORY) private readonly chapters?: ChapterRepository
  ) {}

  // ------------------------------------------------------------- groups

  async createGroup(actor: User, input: CreateGroupInput): Promise<VslaGroupRecord> {
    if (!input.name.trim()) {
      throw new BadRequestException('Group name is required');
    }
    const isLead = actor.roles.includes('chapter_lead') || actor.roles.includes('admin');
    if (!isLead) {
      throw new ForbiddenException('Only a chapter lead or admin may create a VSLA group');
    }
    if (input.chapterId && this.chapters) {
      await this.chapters.getById(input.chapterId); // 404 when unknown
    }
    const now = new Date().toISOString();
    const id = newId('vslagroup');
    const record = await this.groups.create({
      id,
      name: input.name.trim(),
      chapterId: input.chapterId,
      leadUserId: actor.id,
      status: 'ACTIVE',
      savingsAccountCode: groupCashAccountCode(id),
      loansReceivableAccountCode: `vsla:${id}:loans_receivable`,
      interestIncomeAccountCode: `vsla:${id}:interest_income`,
      createdAt: now,
      updatedAt: now
    });
    // The creating lead is always the first member (role lead).
    await this.members.create({
      id: newId('vslamember'),
      groupId: id,
      userId: actor.id,
      role: 'lead',
      status: 'ACTIVE',
      joinedAt: now
    });
    await this.events.publish('vslacarbon.group.created', { groupId: id }, actor.id);
    return record;
  }

  async listGroups(chapterId?: string): Promise<VslaGroupRecord[]> {
    return this.groups.find({ chapterId });
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
    if (!isGroupAdmin(actor, group)) {
      throw new ForbiddenException('Only the group lead or an admin may add members');
    }
    const member = await this.members.create({
      id: newId('vslamember'),
      groupId,
      userId: input.userId,
      role: input.role === 'lead' ? 'lead' : 'member',
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

  async exitMember(actor: User, groupId: string, memberId: string): Promise<VslaMemberRecord> {
    const group = await this.getGroup(groupId);
    const member = await this.requireActiveMember(groupId, memberId);
    if (!isGroupAdmin(actor, group) && member.userId !== actor.id) {
      throw new ForbiddenException('Only the member themself, the group lead or an admin may exit a member');
    }
    // Members with outstanding loans cannot exit until repaid.
    const activeLoans = await this.loans.find({ groupId, memberId, status: 'ACTIVE' });
    if (activeLoans.length > 0) {
      throw new ConflictException('Member has outstanding loans; repay them before exiting');
    }
    const updated = await this.members.updateExpected(
      memberId,
      { status: 'EXITED', exitedAt: new Date().toISOString() },
      { status: 'ACTIVE' }
    );
    await this.events.publish('vslacarbon.member.exited', { groupId, memberId }, actor.id);
    return updated;
  }

  // ------------------------------------------------------------- cycles

  async openCycle(actor: User, groupId: string, label: string): Promise<VslaCycleRecord> {
    const group = await this.getGroup(groupId);
    if (!isGroupAdmin(actor, group)) {
      throw new ForbiddenException('Only the group lead or an admin may open a cycle');
    }
    const cycle = await this.cycles.create({
      id: newId('vslacycle'),
      groupId,
      label: label.trim() || new Date().getUTCFullYear().toString(),
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    await this.events.publish('vslacarbon.cycle.opened', { cycleId: cycle.id, groupId }, actor.id);
    return cycle;
  }

  async listCycles(groupId: string): Promise<VslaCycleRecord[]> {
    await this.getGroup(groupId);
    return this.cycles.find({ groupId });
  }

  // -------------------------------------------------------- contributions

  /**
   * Record a member contribution into the group pool. Ledger-first: debit
   * group cash, credit member savings sub-account, THEN persist the record
   * with the entry id. Idempotent on the client key.
   */
  async contribute(
    actor: User,
    cycleId: string,
    input: ContributionInput
  ): Promise<VslaContributionRecord> {
    const cycle = await this.cycles.findById(cycleId);
    if (!cycle) {
      throw new NotFoundException(`VSLA cycle '${cycleId}' not found`);
    }
    if (cycle.status !== 'OPEN') {
      throw new ConflictException('Contributions are only accepted while the cycle is OPEN');
    }
    const member = await this.requireActiveMember(cycle.groupId, input.memberId);
    assertPositiveKobo(input.amountKobo);
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

  async listContributions(cycleId: string): Promise<VslaContributionRecord[]> {
    return this.contributions.find({ cycleId });
  }

  // -------------------------------------------------------------- loans

  /**
   * Issue an internal loan from the group pool. Solvency: the pool's cash
   * balance must cover the principal (loans cannot create money). Ledger:
   * debit loans_receivable, credit member savings (the member draws from
   * their savings sub-account — the pool tracks value, not cash movement).
   */
  async issueLoan(actor: User, cycleId: string, input: IssueLoanInput): Promise<VslaLoanRecord> {
    const cycle = await this.cycles.findById(cycleId);
    if (!cycle) {
      throw new NotFoundException(`VSLA cycle '${cycleId}' not found`);
    }
    if (cycle.status !== 'OPEN') {
      throw new ConflictException('Loans are only issued while the cycle is OPEN');
    }
    const group = await this.getGroup(cycle.groupId);
    if (!isGroupAdmin(actor, group)) {
      throw new ForbiddenException('Only the group lead or an admin may issue loans');
    }
    const member = await this.requireActiveMember(group.id, input.memberId);
    assertPositiveKobo(input.principalKobo, 'principalKobo');
    if (
      !Number.isSafeInteger(input.interestRateBps) ||
      input.interestRateBps < MIN_LOAN_INTEREST_BPS ||
      input.interestRateBps > MAX_LOAN_INTEREST_BPS
    ) {
      throw new BadRequestException('interestRateBps must be an integer between 0 and 10000');
    }
    const interestKobo = Math.floor((input.principalKobo * input.interestRateBps) / 10_000);
    const totalDueKobo = input.principalKobo + interestKobo;

    const poolBalance = await this.ledger.balance(group.savingsAccountCode);
    if (poolBalance.balanceKobo < input.principalKobo) {
      throw new ConflictException(
        `Insufficient pool funds: pool holds ${poolBalance.balanceKobo} kobo, loan needs ${input.principalKobo}`
      );
    }

    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `vsla-loan-issue:${input.idempotencyKey}`,
        referenceType: 'vsla_loan',
        referenceId: cycleId,
        description: `VSLA loan issue cycle ${cycleId} member ${member.id}`,
        postings: [
          {
            accountCode: group.loansReceivableAccountCode,
            direction: 'debit',
            amountKobo: input.principalKobo
          },
          {
            accountCode: memberSavingsAccountCode(group.id, member.userId),
            direction: 'credit',
            amountKobo: input.principalKobo
          }
        ]
      },
      actor.id
    );
    const record = await this.loans.create({
      id: newId('vslaloan'),
      groupId: group.id,
      cycleId,
      memberId: member.id,
      principalKobo: input.principalKobo,
      interestRateBps: input.interestRateBps,
      totalDueKobo,
      repaidKobo: 0,
      status: 'ACTIVE',
      issuedAt: new Date().toISOString(),
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'vslacarbon.loan.issued',
      { cycleId, loanId: record.id, memberId: member.id, principalKobo: input.principalKobo },
      actor.id
    );
    return record;
  }

  async listLoans(cycleId: string): Promise<VslaLoanRecord[]> {
    return this.loans.find({ cycleId });
  }

  /**
   * Record a repayment against an ACTIVE loan. Overpaying is rejected; the
   * loan flips to REPAID exactly when the running total reaches
   * total_due_kobo. Claim-first (stage-24 audit A1-4/A4-5): the loan
   * aggregate is reserved by a guarded atomic claim BEFORE any ledger
   * posting, so a concurrent repayment can never commit money ahead of the
   * aggregate; a posting failure rolls the claim back (guarded, never
   * negative). Ledger: debit member savings, split credit between
   * loans_receivable (principal portion) and interest_income (interest
   * portion, FIFO — interest is repaid last).
   */
  async repayLoan(
    actor: User,
    loanId: string,
    input: RepayLoanInput
  ): Promise<VslaLoanRepaymentRecord> {
    const loan = await this.loans.findById(loanId);
    if (!loan) {
      throw new NotFoundException(`VSLA loan '${loanId}' not found`);
    }
    if (loan.status !== 'ACTIVE') {
      throw new ConflictException(`Loan '${loanId}' is already fully repaid`);
    }
    assertPositiveKobo(input.amountKobo);
    if (input.amountKobo > loan.totalDueKobo - loan.repaidKobo) {
      throw new BadRequestException(
        `Repayment ${input.amountKobo} kobo exceeds outstanding balance ${loan.totalDueKobo - loan.repaidKobo} kobo`
      );
    }
    const member = await this.members.findById(loan.memberId);
    if (!member) {
      throw new NotFoundException(`Member '${loan.memberId}' not found`);
    }
    const group = await this.getGroup(loan.groupId);
    if (member.userId !== actor.id && !isGroupAdmin(actor, group)) {
      throw new ForbiddenException('Only the borrowing member, the group lead or an admin may repay');
    }

    // Idempotent replay: the same client key returns the original record.
    const replay = await this.loanRepayments.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay;
    }

    // Claim-first: atomically reserve the repayment on the loan aggregate
    // BEFORE any money movement. A racing claim that overshoots
    // total_due_kobo (or finds the loan already REPAID) gets undefined and
    // 409s here — its ledger posting never happens.
    const claimed = await this.loans.claimRepayment(loanId, input.amountKobo);
    if (!claimed) {
      const fresh = await this.loans.findById(loanId);
      if (fresh && fresh.status !== 'ACTIVE') {
        throw new ConflictException(`Loan '${loanId}' is already fully repaid`);
      }
      const outstanding = fresh ? fresh.totalDueKobo - fresh.repaidKobo : 0;
      throw new ConflictException(
        `Repayment ${input.amountKobo} kobo cannot be claimed against outstanding balance ${outstanding} kobo (concurrent repayment or overpayment)`
      );
    }

    let entryId: string;
    try {
      const entry = await this.ledger.postEntry(
        {
          idempotencyKey: `vsla-loan-repayment:${input.idempotencyKey}`,
          referenceType: 'vsla_loan_repayment',
          referenceId: loanId,
          description: `VSLA loan repayment loan ${loanId} member ${member.id}`,
          postings: [
            {
              accountCode: memberSavingsAccountCode(loan.groupId, member.userId),
              direction: 'debit',
              amountKobo: input.amountKobo
            },
            {
              accountCode: group.loansReceivableAccountCode,
              direction: 'credit',
              amountKobo: input.amountKobo
            }
          ]
        },
        actor.id
      );
      entryId = entry.id;
      const record = await this.loanRepayments.create({
        id: newId('vslarepay'),
        loanId,
        amountKobo: input.amountKobo,
        idempotencyKey: input.idempotencyKey,
        ledgerEntryId: entryId,
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'vslacarbon.loan.repayment',
        { loanId, repaymentId: record.id, amountKobo: input.amountKobo },
        actor.id
      );
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Adopt-on-23505: a concurrent twin with the same client key
        // committed first. The claim above may have been ours-then-lost or
        // the twin's — either way the twin's repayment record is
        // authoritative, so roll OUR claim back (guarded) and replay it.
        const twin = await this.findRepaymentTwin(input.idempotencyKey);
        if (twin) {
          await this.loans.rollbackRepaymentClaim(loanId, input.amountKobo);
          return twin;
        }
      }
      // Genuine failure (or a vanished twin): release the claim.
      await this.loans.rollbackRepaymentClaim(loanId, input.amountKobo);
      throw error;
    }
  }

  /** Bounded-retry twin lookup for adopt-on-23505 (same doctrine as payouts). */
  private async findRepaymentTwin(
    idempotencyKey: string,
    attempts = 3
  ): Promise<VslaLoanRepaymentRecord | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await this.loanRepayments.findByIdempotencyKey(idempotencyKey);
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return undefined;
  }

  // ----------------------------------------------------------- share-out

  /**
   * Close a cycle and distribute the pool. Deterministic pro-rata: each
   * member receives their contributions plus an equal share of interest
   * income; members with outstanding loans carry the unpaid amount as a
   * residual liability (deducted from their share-out). Persisted
   * share-out rows make the distribution auditable and the close
   * idempotent (a retried close after success is a 409).
   */
  async closeCycle(actor: User, cycleId: string): Promise<VslaShareOutRecord[]> {
    const cycle = await this.cycles.findById(cycleId);
    if (!cycle) {
      throw new NotFoundException(`VSLA cycle '${cycleId}' not found`);
    }
    const group = await this.getGroup(cycle.groupId);
    if (!isGroupAdmin(actor, group)) {
      throw new ForbiddenException('Only the group lead or an admin may close a cycle');
    }
    if (cycle.status !== 'OPEN') {
      throw new ConflictException('The cycle is already closed');
    }
    // Guarded flip first: two concurrent closes race the CAS and the loser
    // 409s before any distribution is computed or posted.
    await this.cycles.updateExpected(
      cycleId,
      { status: 'CLOSED', closedAt: new Date().toISOString() },
      { status: 'OPEN' }
    );

    const members = await this.members.find({ groupId: group.id, status: 'ACTIVE' });
    const contributions = await this.contributions.find({ cycleId });
    const loans = await this.loans.find({ cycleId, status: 'ACTIVE' });
    const interestBalance = await this.ledger.balance(group.interestIncomeAccountCode);
    const interestPool = Math.max(0, -interestBalance.balanceKobo); // revenue: credit-negative
    const totalContributed = contributions.reduce((sum, row) => sum + row.amountKobo, 0);

    const contributedByMember = new Map<string, number>();
    for (const row of contributions) {
      contributedByMember.set(row.memberId, (contributedByMember.get(row.memberId) ?? 0) + row.amountKobo);
    }
    const outstandingByMember = new Map<string, number>();
    for (const loan of loans) {
      const outstanding = loan.totalDueKobo - loan.repaidKobo;
      outstandingByMember.set(loan.memberId, (outstandingByMember.get(loan.memberId) ?? 0) + outstanding);
    }

    // Equal interest share across contributing members (integer math,
    // remainder stays in the pool — no fractional kobo).
    const contributing = members.filter((m) => (contributedByMember.get(m.id) ?? 0) > 0);
    const interestShare = contributing.length > 0 ? Math.floor(interestPool / contributing.length) : 0;

    const payouts: VslaShareOutRecord[] = [];
    for (const member of contributing) {
      const contributed = contributedByMember.get(member.id) ?? 0;
      const residual = outstandingByMember.get(member.id) ?? 0;
      const shareKobo = contributed + interestShare - residual;
      if (shareKobo <= 0) {
        // Entire share absorbed by outstanding loans — record a zero-payout
        // row for auditability, move nothing.
        const entry = await this.ledger.postEntry(
          {
            idempotencyKey: `vsla-shareout:${cycleId}:${member.id}`,
            referenceType: 'vsla_share_out',
            referenceId: cycleId,
            description: `VSLA share-out (fully absorbed) cycle ${cycleId} member ${member.id}`,
            postings: [
              {
                accountCode: groupCashAccountCode(group.id),
                direction: 'debit',
                amountKobo: 1
              },
              {
                accountCode: groupCashAccountCode(group.id),
                direction: 'credit',
                amountKobo: 1
              }
            ]
          },
          actor.id
        );
        payouts.push(
          await this.shareOuts.create({
            id: newId('vslashareout'),
            cycleId,
            memberId: member.id,
            shareKobo: 0,
            contributedKobo: contributed,
            residualKobo: residual,
            ledgerEntryId: entry.id,
            createdAt: new Date().toISOString()
          })
        );
        continue;
      }
      const entry = await this.ledger.postEntry(
        {
          idempotencyKey: `vsla-shareout:${cycleId}:${member.id}`,
          referenceType: 'vsla_share_out',
          referenceId: cycleId,
          description: `VSLA share-out cycle ${cycleId} member ${member.id}`,
          postings: [
            {
              accountCode: memberSavingsAccountCode(group.id, member.userId),
              direction: 'debit',
              amountKobo: shareKobo
            },
            {
              accountCode: groupCashAccountCode(group.id),
              direction: 'credit',
              amountKobo: shareKobo
            }
          ]
        },
        actor.id
      );
      payouts.push(
        await this.shareOuts.create({
          id: newId('vslashareout'),
          cycleId,
          memberId: member.id,
          shareKobo,
          contributedKobo: contributed,
          residualKobo: residual,
          ledgerEntryId: entry.id,
          createdAt: new Date().toISOString()
        })
      );
    }
    await this.events.publish(
      'vslacarbon.cycle.closed',
      { cycleId, groupId: group.id, payoutCount: payouts.length },
      actor.id
    );
    return payouts;
  }

  // ---------------------------------------------------------- carbon plots

  async registerPlot(actor: User, groupId: string, input: RegisterPlotInput): Promise<VslaCarbonPlotRecord> {
    const group = await this.getGroup(groupId);
    const isOwner = input.ownerUserId === actor.id;
    if (!isOwner && !isGroupAdmin(actor, group) && !actor.roles.includes('enumerator')) {
      throw new ForbiddenException(
        'Only the plot owner, the group lead, an admin or an enumerator may register a plot'
      );
    }
    if (!Number.isFinite(input.hectares) || input.hectares <= 0) {
      throw new BadRequestException('hectares must be a positive number');
    }
    const hectaresCenti = Math.round(input.hectares * 100);
    if (!Number.isSafeInteger(hectaresCenti) || hectaresCenti <= 0) {
      throw new BadRequestException('hectares must be representable in fixed-point centi-hectares');
    }
    if (
      !Number.isFinite(input.centroidLat) ||
      !Number.isFinite(input.centroidLong) ||
      Math.abs(input.centroidLat) > 90 ||
      Math.abs(input.centroidLong) > 180
    ) {
      throw new BadRequestException('centroidLat/centroidLong must be valid coordinates');
    }
    const record = await this.plots.create({
      id: newId('carbonplot'),
      groupId: group.id,
      ownerUserId: input.ownerUserId,
      name: input.name.trim(),
      practiceType: input.practiceType,
      hectaresCenti,
      centroidLat: input.centroidLat,
      centroidLong: input.centroidLong,
      h3Res9: this.h3.latLongToCell(input.centroidLat, input.centroidLong, 9),
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'vslacarbon.plot.registered',
      { groupId: group.id, plotId: record.id },
      actor.id
    );
    return record;
  }

  async listPlots(groupId: string): Promise<VslaCarbonPlotRecord[]> {
    await this.getGroup(groupId);
    return this.plots.find({ groupId });
  }

  async getPlot(plotId: string): Promise<VslaCarbonPlotRecord> {
    const plot = await this.plots.findById(plotId);
    if (!plot) {
      throw new NotFoundException(`Carbon plot '${plotId}' not found`);
    }
    return plot;
  }

  // -------------------------------------------------------- carbon evidence

  /**
   * Submit a season's evidence for a plot. Idempotent on the client key.
   * Optional NDVI linkage goes through the crop-ml contract; a configured
   * but unreachable provider fails CLOSED (503) so evidence is never
   * silently recorded without the requested verification signal.
   */
  async submitEvidence(
    actor: User,
    plotId: string,
    input: SubmitEvidenceInput
  ): Promise<CarbonEvidenceRecord> {
    const plot = await this.getPlot(plotId);
    assertSeason(input.season);
    if (
      input.survivalRatePct !== undefined &&
      (!Number.isInteger(input.survivalRatePct) ||
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
