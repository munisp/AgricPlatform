import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CreditLoanProduct, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCreditCollateralRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGroupRepository,
  createInMemoryCreditGuarantorRepository,
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditRestructureRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository,
  InMemoryCreditProductRepository
} from '../../database/repositories/credit-suite.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { CreditService } from './credit.service.js';
import { CreditGroupsService } from './groups.service.js';

const leader: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const memberA: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['farmer'] };
const memberB: Pick<User, 'id' | 'roles'> = { id: 'user-bala', roles: ['farmer'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-chidi', roles: ['farmer'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const stranger: Pick<User, 'id' | 'roles'> = { id: 'user-stranger', roles: ['farmer'] };

const GROUP_PRODUCT: CreditLoanProduct = {
  id: 'cprd-vsla',
  name: 'VSLA group loan',
  minPrincipalKobo: 100_000,
  maxPrincipalKobo: 10_000_000,
  interestBpsAnnual: 1000,
  termDays: 90,
  groupLending: true,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

function makeServices() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const groups = createInMemoryCreditGroupRepository();
  const members = createInMemoryCreditGroupMemberRepository();
  const transactions = createInMemoryCreditSavingsTransactionRepository();
  const savingsAccounts = createInMemoryCreditSavingsAccountRepository(transactions);
  const guarantors = createInMemoryCreditGuarantorRepository();
  const loans = createInMemoryCreditLoanRepository();
  const repayments = createInMemoryCreditRepaymentRepository();
  const groupsService = new CreditGroupsService(
    events,
    groups,
    members,
    loans,
    repayments,
    guarantors,
    savingsAccounts,
    transactions
  );
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const credit = new CreditService(
    events,
    new InMemoryCreditProductRepository([GROUP_PRODUCT]),
    loans,
    repayments,
    createInMemoryCreditCollateralRepository(),
    guarantors,
    groups,
    members,
    savingsAccounts,
    new InMemoryProfileRepository(),
    new InMemoryOrderRepository(),
    createInMemoryCreditRestructureRepository(),
    transactions,
    ledger
  );
  return { groupsService, credit, guarantors, members, loans, repayments, savingsAccounts, groups };
}

async function threeMemberGroup(services: ReturnType<typeof makeServices>) {
  const { group } = await services.groupsService.createGroup({ name: 'Kano VSLA' }, leader);
  await services.groupsService.join(group.id, memberA);
  await services.groupsService.join(group.id, memberB);
  return group;
}

describe('CreditGroupsService', () => {
  it('creates a group with the creator as leader', async () => {
    const services = makeServices();
    const { group, members } = await services.groupsService.createGroup(
      { name: 'Kano VSLA', chapterId: 'chapter-1' },
      leader
    );
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe('leader');
    const detail = await services.groupsService.getGroup(group.id, leader);
    expect(detail.group.name).toBe('Kano VSLA');
    expect(detail.group.chapterId).toBe('chapter-1');
  });

  it('joins and leaves idempotently; the leader cannot leave a populated group', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    const rejoin = await services.groupsService.join(group.id, memberA);
    expect(rejoin.userId).toBe(memberA.id);
    expect((await services.groupsService.getGroup(group.id, leader)).members).toHaveLength(3);
    await expect(services.groupsService.leave(group.id, leader)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await services.groupsService.leave(group.id, memberA);
    await services.groupsService.leave(group.id, memberA); // idempotent
    expect((await services.groupsService.getGroup(group.id, leader)).members).toHaveLength(2);
  });

  it('restricts member administration to the leader (or admin)', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    await expect(
      services.groupsService.addMember(group.id, outsider.id, memberA)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await services.groupsService.addMember(group.id, outsider.id, leader);
    expect((await services.groupsService.getGroup(group.id, leader)).members).toHaveLength(4);
    // The leader cannot be removed.
    await expect(
      services.groupsService.removeMember(group.id, leader.id, leader)
    ).rejects.toBeInstanceOf(BadRequestException);
    await services.groupsService.removeMember(group.id, outsider.id, leader);
    expect((await services.groupsService.getGroup(group.id, leader)).members).toHaveLength(3);
  });

  it('lists the caller’s groups with members', async () => {
    const services = makeServices();
    await threeMemberGroup(services);
    const mine = await services.groupsService.listMyGroups(memberB);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.members.map((member) => member.userId)).toContain(memberB.id);
  });

  it('scopes listing to the caller’s own groups (G5): non-members see only their groups', async () => {
    const services = makeServices();
    const first = await threeMemberGroup(services);
    // A second group the caller has no membership in.
    await services.groupsService.createGroup({ name: 'Ibadan VSLA' }, outsider);
    const memberList = await services.groupsService.listGroups(memberA);
    expect(memberList.map((group) => group.id)).toEqual([first.id]);
    const strangerList = await services.groupsService.listGroups(stranger);
    expect(strangerList).toHaveLength(0);
    // The outsider created the second group, so they lead and see it only.
    const creatorList = await services.groupsService.listGroups(outsider);
    expect(creatorList).toHaveLength(1);
    expect(creatorList[0]!.name).toBe('Ibadan VSLA');
  });

  it('refuses group detail to non-members (G5): 403 per CreditService.getLoan convention', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    await expect(services.groupsService.getGroup(group.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    // Members and the leader can read it.
    await expect(services.groupsService.getGroup(group.id, memberA)).resolves.toBeDefined();
  });

  it('does not leak the member roster to non-members (G5)', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    // The only roster-bearing read rejects for non-members...
    await expect(services.groupsService.getGroup(group.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    // ...and the membership-scoped listing never exposes rosters at all.
    const listed = await services.groupsService.listGroups(outsider);
    expect(listed).toHaveLength(0);
    const memberView = await services.groupsService.getGroup(group.id, memberB);
    expect(memberView.members.map((member) => member.userId).sort()).toEqual(
      [leader.id, memberA.id, memberB.id].sort()
    );
  });

  it('lets credit reviewers (admin|lender) list and read every group (G5)', async () => {
    const services = makeServices();
    const first = await threeMemberGroup(services);
    const { group: second } = await services.groupsService.createGroup(
      { name: 'Ibadan VSLA' },
      outsider
    );
    const adminList = await services.groupsService.listGroups(admin);
    expect(adminList.map((group) => group.id).sort()).toEqual([first.id, second.id].sort());
    const adminDetail = await services.groupsService.getGroup(first.id, admin);
    expect(adminDetail.members).toHaveLength(3);
    const lenderList = await services.groupsService.listGroups(lender);
    expect(lenderList).toHaveLength(2);
  });
});

describe('CreditService group (VSLA) lending', () => {
  it('records all other members as accepted co-obligor guarantors', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    const loan = await services.credit.applyForGroup(
      { productId: GROUP_PRODUCT.id, principalKobo: 2_000_000, groupId: group.id },
      leader
    );
    expect(loan.groupId).toBe(group.id);
    const guarantors = await services.credit.listGuarantors(loan.id, leader);
    expect(guarantors).toHaveLength(2);
    expect(guarantors.every((guarantor) => guarantor.status === 'accepted')).toBe(true);
    expect(guarantors.map((guarantor) => guarantor.guarantorUserId).sort()).toEqual([
      memberA.id,
      memberB.id
    ]);
    // Co-obligors are parties to the loan.
    await expect(services.credit.getLoan(loan.id, memberA)).resolves.toBeDefined();
    await expect(services.credit.getLoan(loan.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('requires group membership and a group-lending product', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    await expect(
      services.credit.applyForGroup(
        { productId: GROUP_PRODUCT.id, principalKobo: 2_000_000, groupId: group.id },
        outsider
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Individual endpoint refuses group products.
    await expect(
      services.credit.apply({ productId: GROUP_PRODUCT.id, principalKobo: 2_000_000 }, leader)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('walks a group loan through the full lifecycle', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    const loan = await services.credit.applyForGroup(
      { productId: GROUP_PRODUCT.id, principalKobo: 900_000, groupId: group.id },
      leader
    );
    await services.credit.submit(loan.id, leader);
    await services.credit.score(loan.id, lender);
    await services.credit.approve(loan.id, lender);
    const schedule = await services.credit.getSchedule(loan.id, leader);
    expect(schedule).toHaveLength(3); // ceil(90/30)
    // 900_000 * 1000 * 90 / (10000*365) = 22_191 kobo interest (floored).
    expect(schedule.reduce((sum, entry) => sum + entry.amountKobo, 0)).toBe(922_191);
  });
});

/* ------------------------------------------------ V-46 exit + dissolution -- */

describe('V-46 exit-settlement and group dissolution', () => {
  /** Drives a group loan to `repaying` with all co-obligors recorded. */
  async function liveGroupLoan(services: ReturnType<typeof makeServices>, groupId: string) {
    const loan = await services.credit.applyForGroup(
      { productId: GROUP_PRODUCT.id, principalKobo: 900_000, groupId },
      leader
    );
    await services.credit.submit(loan.id, leader);
    await services.credit.score(loan.id, lender);
    await services.credit.approve(loan.id, lender);
    await services.credit.disburse(loan.id, lender);
    return services.credit.startRepayment(loan.id, lender);
  }

  it('exit with a live loan is blocked until the share is settled or substituted', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    await liveGroupLoan(services, group.id);

    // Bare leave: blocked with the computed liability in the message.
    await expect(services.groupsService.leave(group.id, memberA)).rejects.toThrowError(
      /EXIT_SETTLEMENT_REQUIRED/
    );
    // The preview shows the equal share of the outstanding balance.
    const preview = await services.groupsService.exitSettlement(group.id, memberA);
    expect(preview.openLoanIds).toHaveLength(1);
    expect(preview.shareKobo).toBeGreaterThan(0);

    // Guarantor substitution: memberB (already an accepted co-obligor)
    // takes over memberA's positions; memberA's guarantor row is released.
    await services.groupsService.leave(group.id, memberA, { substituteUserId: memberB.id });
    expect((await services.groupsService.getGroup(group.id, leader)).members).toHaveLength(2);
    const released = services.guarantors;
    const memberARow = await released.findOne({ guarantorUserId: memberA.id });
    expect(memberARow!.status).toBe('settled'); // released by substitution
    const memberBRow = await released.findOne({ guarantorUserId: memberB.id });
    expect(memberBRow!.status).toBe('accepted');
  });

  it('exit settles the share from the member’s savings (the call is the consent)', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    await liveGroupLoan(services, group.id);
    const preview = await services.groupsService.exitSettlement(group.id, memberA);

    // No savings → settlement impossible.
    await expect(
      services.groupsService.leave(group.id, memberA, { settleFromSavings: true })
    ).rejects.toThrowError(/no savings account/);

    // Fund memberA just below the share → insufficient.
    const now = new Date().toISOString();
    await services.savingsAccounts.create({
      id: 'csav-aisha',
      userId: memberA.id,
      balanceKobo: preview.shareKobo - 1,
      updatedAt: now
    });
    await expect(
      services.groupsService.leave(group.id, memberA, { settleFromSavings: true })
    ).rejects.toThrowError(/EXIT_SETTLEMENT_INSUFFICIENT/);

    // Fund fully → the exit settles and the member leaves.
    await services.savingsAccounts.applyTransaction(
      'csav-aisha',
      { balanceKobo: preview.shareKobo - 1 },
      { balanceKobo: preview.shareKobo, updatedAt: new Date().toISOString() },
      {
        id: 'ctxn-topup',
        accountId: 'csav-aisha',
        direction: 'deposit',
        amountKobo: 1,
        balanceAfterKobo: preview.shareKobo,
        ref: 'top-up',
        createdAt: new Date().toISOString()
      }
    );
    await services.groupsService.leave(group.id, memberA, { settleFromSavings: true });
    expect((await services.groupsService.getGroup(group.id, leader)).members).toHaveLength(2);
    expect((await services.savingsAccounts.getById('csav-aisha')).balanceKobo).toBe(0);
  });

  it('dissolution is blocked with open liabilities and succeeds once the loan closes', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    const loan = await liveGroupLoan(services, group.id);

    await expect(services.groupsService.dissolve(group.id, leader)).rejects.toThrowError(
      /DISSOLVE_BLOCKED/
    );
    // Non-leader cannot dissolve.
    await expect(services.groupsService.dissolve(group.id, memberA)).rejects.toBeInstanceOf(
      ForbiddenException
    );

    // Close the loan: all installments paid → dissolution unblocks.
    const schedule = await services.credit.getSchedule(loan.id, leader);
    for (const entry of schedule) {
      await services.credit.recordPayment(loan.id, entry.sequence, leader);
    }
    const dissolved = await services.groupsService.dissolve(group.id, leader);
    expect(dissolved.status).toBe('dissolved');
    expect(dissolved.dissolvedAt).toBeDefined();
    // Idempotent replay.
    expect((await services.groupsService.dissolve(group.id, leader)).status).toBe('dissolved');

    // A dissolved group is closed: no joins, no member adds, no new group loans.
    await expect(services.groupsService.join(group.id, outsider)).rejects.toThrowError(
      /dissolved/
    );
    await expect(
      services.groupsService.addMember(group.id, outsider.id, leader)
    ).rejects.toThrowError(/dissolved/);
    await expect(
      services.credit.applyForGroup(
        { productId: GROUP_PRODUCT.id, principalKobo: 500_000, groupId: group.id },
        leader
      )
    ).rejects.toThrowError(/dissolved/);
  });

  it('dissolution is blocked by unsettled guarantor demands even with closed loans', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    const loan = await liveGroupLoan(services, group.id);
    // Default issues demands to memberA and memberB (called).
    await services.credit.defaultLoan(loan.id, lender);
    await expect(services.groupsService.dissolve(group.id, leader)).rejects.toThrowError(
      /DISSOLVE_BLOCKED/
    );
  });
});
