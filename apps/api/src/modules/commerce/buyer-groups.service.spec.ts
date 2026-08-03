import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createInMemoryBuyerGroupRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { BuyerGroupsService } from './buyer-groups.service.js';

const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const agent: Pick<User, 'id' | 'roles'> = { id: 'user-agent', roles: ['chapter_lead'] };
const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new BuyerGroupsService(
    events,
    createInMemoryBuyerGroupRepository(),
    createInMemoryBuyerGroupMembershipRepository()
  );
  return { service, events };
}

describe('BuyerGroupsService', () => {
  it('creates groups as admin or agent roles', async () => {
    const { service } = makeService();
    const byAdmin = await service.createGroup({ name: 'Cooperatives' }, admin);
    const byAgent = await service.createGroup({ name: 'Processors' }, agent);
    expect(byAdmin.isActive).toBe(true);
    expect(byAgent.id).toMatch(/^bgroup-/);
    expect(await service.listGroups(admin)).toHaveLength(2);
  });

  it('rejects group management by ordinary buyers', async () => {
    const { service } = makeService();
    await expect(service.createGroup({ name: 'X' }, buyer)).rejects.toThrowError(ForbiddenException);
    const group = await service.createGroup({ name: 'Cooperatives' }, admin);
    await expect(service.updateGroup(group.id, { name: 'Y' }, buyer)).rejects.toThrowError(ForbiddenException);
    await expect(service.addMember(group.id, 'user-buyer', buyer)).rejects.toThrowError(ForbiddenException);
    await expect(service.removeMember(group.id, 'user-buyer', buyer)).rejects.toThrowError(ForbiddenException);
  });

  it('rejects duplicate group names', async () => {
    const { service } = makeService();
    await service.createGroup({ name: 'Cooperatives' }, admin);
    await expect(service.createGroup({ name: 'Cooperatives' }, admin)).rejects.toThrowError(ConflictException);
  });

  it('updates name/description/active state', async () => {
    const { service } = makeService();
    const group = await service.createGroup({ name: 'Cooperatives' }, admin);
    const updated = await service.updateGroup(group.id, { description: 'Kano coops', isActive: false }, admin);
    expect(updated.description).toBe('Kano coops');
    expect(updated.isActive).toBe(false);
  });

  it('manages membership with uniqueness enforcement', async () => {
    const { service } = makeService();
    const group = await service.createGroup({ name: 'Cooperatives' }, admin);
    await service.addMember(group.id, 'user-buyer', admin);
    await expect(service.addMember(group.id, 'user-buyer', admin)).rejects.toThrowError(ConflictException);
    expect(await service.listMembers(group.id, admin)).toHaveLength(1);
    await service.removeMember(group.id, 'user-buyer', agent);
    expect(await service.listMembers(group.id, admin)).toHaveLength(0);
    await expect(service.removeMember(group.id, 'user-buyer', admin)).rejects.toThrowError(NotFoundException);
  });

  it('resolves active group ids for a user (drives price lists/promotions)', async () => {
    const { service } = makeService();
    const a = await service.createGroup({ name: 'A' }, admin);
    const b = await service.createGroup({ name: 'B' }, admin);
    await service.addMember(a.id, 'user-buyer', admin);
    await service.addMember(b.id, 'user-buyer', admin);
    await service.updateGroup(b.id, { isActive: false }, admin);
    expect(await service.groupIdsForUser('user-buyer')).toEqual([a.id]);
    expect(await service.groupIdsForUser('user-hassan')).toEqual([]);
  });

  it('404s membership ops on unknown groups', async () => {
    const { service } = makeService();
    await expect(service.addMember('bgroup-missing', 'user-buyer', admin)).rejects.toThrowError(NotFoundException);
    await expect(service.listMembers('bgroup-missing', admin)).rejects.toThrowError(NotFoundException);
  });

  it('publishes membership events', async () => {
    const { service, events } = makeService();
    const group = await service.createGroup({ name: 'Cooperatives' }, admin);
    await service.addMember(group.id, 'user-buyer', admin);
    await service.removeMember(group.id, 'user-buyer', admin);
    const names = (await events.listOutbox()).map((event) => event.name);
    expect(names).toEqual([
      'marketplace.buyer_group.created',
      'marketplace.buyer_group.member_added',
      'marketplace.buyer_group.member_removed'
    ]);
  });
});

describe('BuyerGroupsService read scoping (G12)', () => {
  it('managers see all groups; regular users see only groups they belong to', async () => {
    const { service } = makeService();
    const mine = await service.createGroup({ name: 'Cooperatives' }, admin);
    const other = await service.createGroup({ name: 'Processors' }, admin);
    await service.addMember(mine.id, 'user-buyer', admin);

    // Managers (admin / chapter_lead / partner): full directory.
    expect(await service.listGroups(admin)).toHaveLength(2);
    expect(await service.listGroups(agent)).toHaveLength(2);

    // Regular user: only their own groups; a non-member sees nothing.
    const buyerGroups = await service.listGroups(buyer);
    expect(buyerGroups.map((g) => g.id)).toEqual([mine.id]);
    expect(await service.listGroups({ id: 'user-hassan', roles: ['buyer'] })).toHaveLength(0);
    void other;
  });

  it('members may read their own group roster; outsiders and other members get 403', async () => {
    const { service } = makeService();
    const group = await service.createGroup({ name: 'Cooperatives' }, admin);
    const other = await service.createGroup({ name: 'Processors' }, admin);
    await service.addMember(group.id, 'user-buyer', admin);
    await service.addMember(other.id, 'user-hassan', admin);

    // Member reads their own roster; manager reads any roster.
    expect(await service.listMembers(group.id, buyer)).toHaveLength(1);
    expect(await service.listMembers(group.id, agent)).toHaveLength(1);

    // A user belonging to a DIFFERENT group is still an outsider here.
    await expect(
      service.listMembers(group.id, { id: 'user-hassan', roles: ['buyer'] })
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      service.listMembers(other.id, buyer)
    ).rejects.toThrowError(ForbiddenException);
  });
});
