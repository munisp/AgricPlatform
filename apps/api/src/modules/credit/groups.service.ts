import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type {
  CreditGroup,
  CreditGroupMember,
  CreditGroupRole,
  CreditLoanApplication,
  CreditLoanStatus
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY,
  CREDIT_GUARANTOR_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  CREDIT_SAVINGS_TRANSACTION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CreditGroupMemberRepository,
  CreditGroupRepository,
  CreditGuarantorRepository,
  CreditLoanRepository,
  CreditRepaymentRepository,
  CreditSavingsAccountRepository,
  CreditSavingsTransactionRepository
} from '../../database/repositories/credit-suite.repository.js';
import { installmentOutstandingKobo, isCreditReviewer, type CreditActor } from './credit.service.js';

export interface CreateCreditGroupInput {
  name: string;
  chapterId?: string;
}

export interface CreditGroupWithMembers {
  group: CreditGroup;
  members: CreditGroupMember[];
}

/** V-46: how the exiting member discharges their open liability share. */
export interface LeaveGroupOptions {
  /**
   * Settle the computed share from the member's own savings (the call IS
   * the recorded consent — the member initiates the debit themselves).
   * Idempotent by ref `exit-settlement:<groupId>:<userId>`.
   */
  settleFromSavings?: boolean;
  /**
   * Substitute another EXISTING member as guarantor on the group's live
   * loans, releasing the leaver's guarantor rows (called/liable/accepted →
   * settled-by-substitution).
   */
  substituteUserId?: string;
}

/** V-46: a member's computed open liability towards the group's live loans. */
export interface ExitSettlementPreview {
  groupId: string;
  userId: string;
  /** Live group loans (disbursed/repaying/defaulted). */
  openLoanIds: string[];
  /** Equal-share of the outstanding balance across current members. */
  shareKobo: number;
  /** Open guarantor demands (called/liable) held by the member. */
  openDemandKobo: number;
  /** shareKobo + openDemandKobo — must be discharged before exit. */
  totalLiabilityKobo: number;
}

/** Group-loan statuses that constitute an open liability (V-46). */
const OPEN_GROUP_LOAN_STATUSES: ReadonlySet<CreditLoanStatus> = new Set([
  'approved',
  'disbursed',
  'repaying',
  'defaulted'
]);

/**
 * VSLA/chama group management (Wave CREDIT). The creator becomes the group
 * leader; leaders administer membership. Group loans and group savings are
 * anchored on these groups (see CreditService.applyForGroup and
 * CreditSavingsService).
 *
 * Wave-2 V-46: exit-settlement and dissolution — a member with an open
 * liability share (live group loans / unsettled guarantor demands) can only
 * leave after settling it from savings or arranging a guarantor
 * substitution; a group can only be dissolved with no open liabilities.
 */
@Injectable()
export class CreditGroupsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CREDIT_GROUP_REPOSITORY) private readonly groups: CreditGroupRepository,
    @Inject(CREDIT_GROUP_MEMBER_REPOSITORY) private readonly members: CreditGroupMemberRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(CREDIT_GUARANTOR_REPOSITORY) private readonly guarantors: CreditGuarantorRepository,
    @Inject(CREDIT_SAVINGS_ACCOUNT_REPOSITORY)
    private readonly savingsAccounts: CreditSavingsAccountRepository,
    @Inject(CREDIT_SAVINGS_TRANSACTION_REPOSITORY)
    private readonly savingsTransactions: CreditSavingsTransactionRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  async createGroup(input: CreateCreditGroupInput, actor: CreditActor): Promise<CreditGroupWithMembers> {
    if (!input.name.trim()) {
      throw new BadRequestException('Group name is required');
    }
    const group: CreditGroup = {
      id: newId('cgrp'),
      name: input.name.trim(),
      chapterId: input.chapterId,
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
      status: 'active'
    };
    const created = await this.groups.create(group);
    const leader = await this.members.add({
      groupId: created.id,
      userId: actor.id,
      role: 'leader',
      joinedAt: group.createdAt
    });
    await this.events.publish(
      'credit.group.created',
      { groupId: created.id, name: created.name, createdBy: actor.id },
      actor.id
    );
    return { group: created, members: [leader] };
  }

  /**
   * Membership-scoped listing (G5): credit reviewers (admin|lender — the
   * same predicate CreditService.listLoans uses) see every group; any other
   * caller sees only the groups they belong to. VSLA groups and their
   * rosters are not public directory data.
   */
  async listGroups(actor: CreditActor): Promise<CreditGroup[]> {
    if (isCreditReviewer(actor)) {
      return this.groups.find({});
    }
    const memberships = await this.members.listByUser(actor.id);
    const mine = new Set(memberships.map((membership) => membership.groupId));
    return (await this.groups.find({})).filter((group) => mine.has(group.id));
  }

  /**
   * Group detail with roster (G5): reviewers may read any group; other
   * callers must be members — the same party-scoping convention as
   * CreditService.getLoan (403 for non-parties).
   */
  async getGroup(groupId: string, actor: CreditActor): Promise<CreditGroupWithMembers> {
    const group = await this.groups.getById(groupId);
    if (!isCreditReviewer(actor)) {
      const membership = await this.members.find(groupId, actor.id);
      if (!membership) {
        throw new ForbiddenException('You may only view groups you belong to');
      }
    }
    const members = await this.members.listByGroup(groupId);
    return { group, members };
  }

  async listMyGroups(actor: CreditActor): Promise<CreditGroupWithMembers[]> {
    const memberships = await this.members.listByUser(actor.id);
    const result: CreditGroupWithMembers[] = [];
    for (const membership of memberships) {
      result.push(await this.getGroup(membership.groupId, actor));
    }
    return result;
  }

  /** Self-join as a member (idempotent). Dissolved groups are closed. */
  async join(groupId: string, actor: CreditActor): Promise<CreditGroupMember> {
    const group = await this.groups.getById(groupId);
    if (group.status === 'dissolved') {
      throw new BadRequestException(`Group ${groupId} is dissolved; membership is closed`);
    }
    const existing = await this.members.find(groupId, actor.id);
    if (existing) {
      return existing;
    }
    const member = await this.members.add({
      groupId,
      userId: actor.id,
      role: 'member',
      joinedAt: new Date().toISOString()
    });
    await this.events.publish('credit.group.member_joined', { groupId, userId: actor.id }, actor.id);
    return member;
  }

  /**
   * V-46: a member's open liability towards the group's live loans —
   *   shareKobo:       equal share of the outstanding balance across the
   *                    group's live loans (one share per current member);
   *   openDemandKobo:  the member's unsettled guarantor demands
   *                    (called/liable) on the group's loans.
   * Exit is blocked until the total is discharged by settlement or
   * substitution (see leave()).
   */
  async exitSettlement(groupId: string, actor: CreditActor): Promise<ExitSettlementPreview> {
    await this.groups.getById(groupId);
    const membership = await this.members.find(groupId, actor.id);
    if (!membership && !isCreditReviewer(actor)) {
      throw new ForbiddenException('You may only preview your own exit settlement');
    }
    const userId = membership ? actor.id : actor.id;
    const openLoans = await this.openGroupLoans(groupId);
    const memberCount = Math.max(1, await this.members.countByGroup(groupId));
    let outstandingKobo = 0;
    for (const loan of openLoans) {
      if (loan.status === 'approved') {
        outstandingKobo += loan.principalKobo; // committed, not yet scheduled
        continue;
      }
      const schedule = await this.repayments.find({ loanId: loan.id });
      outstandingKobo += schedule.reduce(
        (sum, repayment) => sum + installmentOutstandingKobo(repayment),
        0
      );
    }
    const shareKobo = openLoans.length > 0 ? Math.ceil(outstandingKobo / memberCount) : 0;
    let openDemandKobo = 0;
    for (const status of ['called', 'liable'] as const) {
      const demands = await this.guarantors.find({ guarantorUserId: userId, status });
      for (const demand of demands) {
        const demandLoan = await this.loans.getById(demand.loanId);
        if (demandLoan.groupId === groupId) {
          openDemandKobo += demand.demandAmountKobo ?? 0;
        }
      }
    }
    return {
      groupId,
      userId,
      openLoanIds: openLoans.map((loan) => loan.id),
      shareKobo,
      openDemandKobo,
      totalLiabilityKobo: shareKobo + openDemandKobo
    };
  }

  /**
   * Self-leave with exit-settlement (V-46). The leader may not leave while
   * other members remain (the group would be orphaned); remove the members
   * or dissolve first. A member with an open liability share towards the
   * group's live loans must discharge it IN THE SAME CALL:
   *   - options.settleFromSavings: debit the share from the member's own
   *     savings into the group savings account (the call is the recorded
   *     consent), idempotent by ref `exit-settlement:<groupId>:<userId>`;
   *   - options.substituteUserId: an existing member takes over the
   *     leaver's guarantor positions on the group's live loans.
   * With no open liability the leave is unconditional (idempotent).
   */
  async leave(groupId: string, actor: CreditActor, options: LeaveGroupOptions = {}): Promise<void> {
    const membership = await this.members.find(groupId, actor.id);
    if (!membership) {
      return; // idempotent
    }
    if (membership.role === 'leader' && (await this.members.countByGroup(groupId)) > 1) {
      throw new BadRequestException(
        'The group leader cannot leave while other members remain'
      );
    }
    const preview = await this.exitSettlement(groupId, actor);
    if (preview.totalLiabilityKobo > 0) {
      if (options.substituteUserId) {
        await this.substituteGuarantor(groupId, actor, options.substituteUserId, preview);
      } else if (options.settleFromSavings) {
        await this.settleExitShare(groupId, actor, preview);
      } else {
        throw new BadRequestException(
          `EXIT_SETTLEMENT_REQUIRED: you carry ${preview.totalLiabilityKobo} kobo of open liability ` +
            `(share ${preview.shareKobo} + demands ${preview.openDemandKobo}) towards this group's live loans; ` +
            `settle it from savings or nominate a substitute guarantor`
        );
      }
    }
    await this.members.remove(groupId, actor.id);
    await this.events.publish(
      'credit.group.member_left',
      {
        groupId,
        userId: actor.id,
        settledKobo: options.settleFromSavings ? preview.shareKobo : 0,
        substituteUserId: options.substituteUserId
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.group.member_left',
      entityType: 'credit_group',
      entityId: groupId,
      metadata: {
        userId: actor.id,
        liabilityKobo: preview.totalLiabilityKobo,
        settledFromSavings: options.settleFromSavings === true,
        substituteUserId: options.substituteUserId
      }
    });
  }

  /**
   * V-46: dissolve a group (leader or admin). Blocked while the group has
   * open liabilities — any live group loan or any unsettled guarantor
   * demand on one. The status flip is a CAS (active → dissolved) so a
   * dissolve racing a new group loan application cannot both win.
   */
  async dissolve(groupId: string, actor: CreditActor): Promise<CreditGroup> {
    await this.requireLeader(groupId, actor);
    const group = await this.groups.getById(groupId);
    if (group.status === 'dissolved') {
      return group; // idempotent replay
    }
    const openLoans = await this.openGroupLoans(groupId);
    if (openLoans.length > 0) {
      throw new BadRequestException(
        `DISSOLVE_BLOCKED: group ${groupId} has ${openLoans.length} open loan(s); ` +
          `settle or close them before dissolving`
      );
    }
    // Open guarantor demands on any loan of this group block dissolution.
    const groupLoanIds = new Set(
      (await this.loans.find({ groupId })).map((loan) => loan.id)
    );
    for (const status of ['called', 'liable'] as const) {
      for (const loanId of groupLoanIds) {
        const demands = await this.guarantors.find({ loanId, status });
        if (demands.length > 0) {
          throw new BadRequestException(
            `DISSOLVE_BLOCKED: group ${groupId} has unsettled guarantor demands; resolve them before dissolving`
          );
        }
      }
    }
    const now = new Date().toISOString();
    const updated = await this.groups.updateExpected(
      groupId,
      { status: 'dissolved', dissolvedAt: now },
      { status: 'active' }
    );
    await this.events.publish('credit.group.dissolved', { groupId }, actor.id);
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.group.dissolved',
      entityType: 'credit_group',
      entityId: groupId,
      metadata: {}
    });
    return updated;
  }

  /** Live group loans (open liability) for exit-settlement/dissolution. */
  private async openGroupLoans(groupId: string): Promise<CreditLoanApplication[]> {
    return (await this.loans.find({ groupId })).filter((loan) =>
      OPEN_GROUP_LOAN_STATUSES.has(loan.status)
    );
  }

  /**
   * Settlement leg of an exit: withdraw the share from the member's
   * personal savings and deposit it into the group account. Both movements
   * go through the guarded balance-CAS path and are idempotent by
   * deterministic refs, so a retried leave never double-moves money.
   */
  private async settleExitShare(
    groupId: string,
    actor: CreditActor,
    preview: ExitSettlementPreview
  ): Promise<void> {
    const amountKobo = preview.shareKobo;
    if (amountKobo <= 0) {
      return; // only demands to discharge — handled by substitution or reviewer settlement
    }
    const personal = await this.savingsAccounts.findOne({ userId: actor.id });
    if (!personal) {
      throw new BadRequestException(
        'EXIT_SETTLEMENT_REQUIRED: you have no savings account to settle the exit share from'
      );
    }
    const ref = `exit-settlement:${groupId}:${actor.id}`;
    if (await this.savingsTransactions.findOne({ ref: `${ref}:withdraw` })) {
      return; // idempotent replay: the settlement already moved the share
    }
    const current = await this.savingsAccounts.getById(personal.id);
    if (current.balanceKobo < amountKobo) {
      throw new BadRequestException(
        `EXIT_SETTLEMENT_INSUFFICIENT: savings balance ${current.balanceKobo} kobo cannot cover the ${amountKobo} kobo exit share`
      );
    }
    const now = new Date().toISOString();
    await this.savingsAccounts.applyTransaction(
      personal.id,
      { balanceKobo: current.balanceKobo },
      { balanceKobo: current.balanceKobo - amountKobo, updatedAt: now },
      {
        id: newId('ctxn'),
        accountId: personal.id,
        direction: 'withdrawal',
        amountKobo,
        balanceAfterKobo: current.balanceKobo - amountKobo,
        ref: `${ref}:withdraw`,
        createdAt: now
      }
    );
    const groupAccount = await this.savingsAccounts.findOne({ groupId });
    if (groupAccount) {
      const groupCurrent = await this.savingsAccounts.getById(groupAccount.id);
      await this.savingsAccounts.applyTransaction(
        groupAccount.id,
        { balanceKobo: groupCurrent.balanceKobo },
        { balanceKobo: groupCurrent.balanceKobo + amountKobo, updatedAt: now },
        {
          id: newId('ctxn'),
          accountId: groupAccount.id,
          direction: 'deposit',
          amountKobo,
          balanceAfterKobo: groupCurrent.balanceKobo + amountKobo,
          ref: `${ref}:deposit`,
          createdAt: now
        }
      );
    }
    await this.events.publish(
      'credit.group.exit_settled',
      { groupId, userId: actor.id, amountKobo, ref },
      actor.id
    );
  }

  /**
   * Substitution leg of an exit: the substitute (an existing member, not
   * the leaver) becomes an accepted guarantor on each of the group's live
   * loans, and the leaver's guarantor rows on those loans are released
   * (any of accepted/called/liable → settled with the substitution noted).
   */
  private async substituteGuarantor(
    groupId: string,
    actor: CreditActor,
    substituteUserId: string,
    preview: ExitSettlementPreview
  ): Promise<void> {
    if (substituteUserId === actor.id) {
      throw new BadRequestException('A member cannot substitute for themselves');
    }
    const substitute = await this.members.find(groupId, substituteUserId);
    if (!substitute) {
      throw new BadRequestException(
        `SUBSTITUTE_NOT_MEMBER: ${substituteUserId} is not a member of group ${groupId}`
      );
    }
    const now = new Date().toISOString();
    for (const loanId of preview.openLoanIds) {
      const leaver = await this.guarantors.findOne({ loanId, guarantorUserId: actor.id });
      if (leaver?.status === 'liable') {
        // The leaver already ACCEPTED this liability and a ledger leg stands
        // against them — substitution cannot unwind booked liability; the
        // demand must be settled first.
        throw new BadRequestException(
          `EXIT_SETTLEMENT_REQUIRED: demand ${leaver.id} is already liable; settle it before substitution`
        );
      }
      const existing = await this.guarantors.findOne({
        loanId,
        guarantorUserId: substituteUserId
      });
      if (!existing) {
        await this.guarantors.create({
          id: newId('cgar'),
          loanId,
          guarantorUserId: substituteUserId,
          status: 'accepted'
        });
      }
      // Release the leaver's guarantor positions on this loan.
      if (leaver && ['accepted', 'called'].includes(leaver.status)) {
        try {
          await this.guarantors.updateExpected(
            leaver.id,
            { status: 'settled', settledAt: now },
            { status: leaver.status }
          );
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          // Concurrent demand transition — the demand lifecycle owns it now.
        }
      }
    }
    await this.events.publish(
      'credit.group.guarantor_substituted',
      { groupId, userId: actor.id, substituteUserId, loanIds: preview.openLoanIds },
      actor.id
    );
  }

  /** Leader (or admin) adds another user as a member. Dissolved groups are closed. */
  async addMember(groupId: string, userId: string, actor: CreditActor): Promise<CreditGroupMember> {
    await this.requireLeader(groupId, actor);
    const group = await this.groups.getById(groupId);
    if (group.status === 'dissolved') {
      throw new BadRequestException(`Group ${groupId} is dissolved; membership is closed`);
    }
    const existing = await this.members.find(groupId, userId);
    if (existing) {
      return existing;
    }
    const member = await this.members.add({
      groupId,
      userId,
      role: 'member',
      joinedAt: new Date().toISOString()
    });
    await this.events.publish('credit.group.member_joined', { groupId, userId }, actor.id);
    return member;
  }

  /** Leader (or admin) removes a member; the leader cannot be removed. */
  async removeMember(groupId: string, userId: string, actor: CreditActor): Promise<void> {
    await this.requireLeader(groupId, actor);
    const membership = await this.members.find(groupId, userId);
    if (!membership) {
      return; // idempotent
    }
    if (membership.role === 'leader') {
      throw new BadRequestException('The group leader cannot be removed');
    }
    await this.members.remove(groupId, userId);
    await this.events.publish('credit.group.member_left', { groupId, userId }, actor.id);
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.group.member_removed',
      entityType: 'credit_group',
      entityId: groupId,
      metadata: { userId }
    });
  }

  /** Membership/role lookup used by the savings service. */
  async membership(groupId: string, userId: string): Promise<CreditGroupMember | undefined> {
    return this.members.find(groupId, userId);
  }

  private async requireLeader(groupId: string, actor: CreditActor): Promise<CreditGroupMember> {
    if (actor.roles.includes('admin')) {
      const membership = await this.members.find(groupId, actor.id);
      if (membership) {
        return membership;
      }
      return { groupId, userId: actor.id, role: 'leader', joinedAt: new Date().toISOString() };
    }
    const membership = await this.members.find(groupId, actor.id);
    if (!membership || membership.role !== ('leader' satisfies CreditGroupRole)) {
      throw new ForbiddenException('Only the group leader may administer membership');
    }
    return membership;
  }
}
