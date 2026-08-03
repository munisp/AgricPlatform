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
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository,
  InMemoryCreditProductRepository
} from '../../database/repositories/credit-suite.repository.js';
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
  const groupsService = new CreditGroupsService(events, groups, members);
  const credit = new CreditService(
    events,
    new InMemoryCreditProductRepository([GROUP_PRODUCT]),
    createInMemoryCreditLoanRepository(),
    createInMemoryCreditRepaymentRepository(),
    createInMemoryCreditCollateralRepository(),
    guarantors,
    members,
    savingsAccounts,
    new InMemoryProfileRepository(),
    new InMemoryOrderRepository()
  );
  return { groupsService, credit, guarantors, members };
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
    const detail = await services.groupsService.getGroup(group.id);
    expect(detail.group.name).toBe('Kano VSLA');
    expect(detail.group.chapterId).toBe('chapter-1');
  });

  it('joins and leaves idempotently; the leader cannot leave a populated group', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    const rejoin = await services.groupsService.join(group.id, memberA);
    expect(rejoin.userId).toBe(memberA.id);
    expect((await services.groupsService.getGroup(group.id)).members).toHaveLength(3);
    await expect(services.groupsService.leave(group.id, leader)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await services.groupsService.leave(group.id, memberA);
    await services.groupsService.leave(group.id, memberA); // idempotent
    expect((await services.groupsService.getGroup(group.id)).members).toHaveLength(2);
  });

  it('restricts member administration to the leader (or admin)', async () => {
    const services = makeServices();
    const group = await threeMemberGroup(services);
    await expect(
      services.groupsService.addMember(group.id, outsider.id, memberA)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await services.groupsService.addMember(group.id, outsider.id, leader);
    expect((await services.groupsService.getGroup(group.id)).members).toHaveLength(4);
    // The leader cannot be removed.
    await expect(
      services.groupsService.removeMember(group.id, leader.id, leader)
    ).rejects.toBeInstanceOf(BadRequestException);
    await services.groupsService.removeMember(group.id, outsider.id, leader);
    expect((await services.groupsService.getGroup(group.id)).members).toHaveLength(3);
  });

  it('lists the caller’s groups with members', async () => {
    const services = makeServices();
    await threeMemberGroup(services);
    const mine = await services.groupsService.listMyGroups(memberB);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.members.map((member) => member.userId)).toContain(memberB.id);
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
