import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { BuyerGroup, BuyerGroupMembership, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  BUYER_GROUP_MEMBERSHIP_REPOSITORY,
  BUYER_GROUP_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  BuyerGroupMembershipRepository,
  BuyerGroupRepository
} from '../../database/repositories/commerce-depth.repository.js';

export interface CreateBuyerGroupInput {
  name: string;
  description?: string;
}

export interface UpdateBuyerGroupInput {
  name?: string;
  description?: string;
  isActive?: boolean;
}

/** Roles that may manage buyer groups and their membership. */
export const BUYER_GROUP_MANAGER_ROLES = ['admin', 'chapter_lead', 'partner'] as const;

export function isBuyerGroupManager(actor: Pick<User, 'id' | 'roles'>): boolean {
  return BUYER_GROUP_MANAGER_ROLES.some((role) => actor.roles.includes(role));
}

export function assertBuyerGroupManager(actor: Pick<User, 'id' | 'roles'>): void {
  if (!isBuyerGroupManager(actor)) {
    throw new ForbiddenException('Only an administrator or agent may manage buyer groups');
  }
}

/**
 * Feature 4 (Wave M): buyer groups. Membership drives price-list and
 * promotion conditions; groups are managed by admins and agent-equivalent
 * roles (chapter leads, partners — the platform has no distinct 'agent'
 * role in USER_ROLES).
 */
@Injectable()
export class BuyerGroupsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(BUYER_GROUP_REPOSITORY) private readonly groups: BuyerGroupRepository,
    @Inject(BUYER_GROUP_MEMBERSHIP_REPOSITORY) private readonly memberships: BuyerGroupMembershipRepository
  ) {}

  /**
   * Membership-scoped listing (G12): managers (admin/chapter_lead/partner)
   * see every group; regular users see only the groups they belong to —
   * group rosters drive pricing, so they are not public directory data.
   */
  async listGroups(actor: Pick<User, 'id' | 'roles'>): Promise<BuyerGroup[]> {
    if (isBuyerGroupManager(actor)) {
      return this.groups.all();
    }
    const memberships = await this.memberships.find({ userId: actor.id });
    const mine = new Set(memberships.map((membership) => membership.groupId));
    return (await this.groups.all()).filter((group) => mine.has(group.id));
  }

  async getGroup(id: string): Promise<BuyerGroup> {
    return this.groups.getById(id);
  }

  async createGroup(input: CreateBuyerGroupInput, actor: Pick<User, 'id' | 'roles'>): Promise<BuyerGroup> {
    assertBuyerGroupManager(actor);
    if (!input.name.trim()) {
      throw new BadRequestException('A buyer group name is required');
    }
    const now = new Date().toISOString();
    const group: BuyerGroup = {
      id: newId('bgroup'),
      name: input.name.trim(),
      description: input.description,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.groups.create(group);
    await this.events.publish('marketplace.buyer_group.created', { groupId: created.id }, actor.id);
    return created;
  }

  async updateGroup(
    id: string,
    patch: UpdateBuyerGroupInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<BuyerGroup> {
    assertBuyerGroupManager(actor);
    await this.groups.getById(id);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new BadRequestException('A buyer group name is required');
    }
    const updated = await this.groups.update(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      updatedAt: new Date().toISOString()
    });
    await this.events.publish('marketplace.buyer_group.updated', { groupId: id }, actor.id);
    return updated;
  }

  /**
   * Managers see any group's roster; regular users only the rosters of
   * groups they themselves belong to (G12).
   */
  async listMembers(
    groupId: string,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<BuyerGroupMembership[]> {
    await this.groups.getById(groupId);
    if (!isBuyerGroupManager(actor)) {
      const own = await this.memberships.find({ groupId, userId: actor.id });
      if (own.length === 0) {
        throw new ForbiddenException('You may only view members of groups you belong to');
      }
    }
    return this.memberships.find({ groupId });
  }

  async addMember(
    groupId: string,
    userId: string,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<BuyerGroupMembership> {
    assertBuyerGroupManager(actor);
    await this.groups.getById(groupId);
    const membership: BuyerGroupMembership = {
      id: newId('bgmember'),
      groupId,
      userId,
      createdAt: new Date().toISOString()
    };
    const created = await this.memberships.create(membership);
    await this.events.publish('marketplace.buyer_group.member_added', { groupId, userId }, actor.id);
    return created;
  }

  async removeMember(groupId: string, userId: string, actor: Pick<User, 'id' | 'roles'>): Promise<void> {
    assertBuyerGroupManager(actor);
    await this.groups.getById(groupId);
    const removed = await this.memberships.removeMembership(groupId, userId);
    if (!removed) {
      throw new NotFoundException(`User '${userId}' is not a member of buyer group '${groupId}'`);
    }
    await this.events.publish('marketplace.buyer_group.member_removed', { groupId, userId }, actor.id);
  }

  /** Ids of the active groups a buyer belongs to (price/promotion conditions). */
  async groupIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.memberships.find({ userId });
    const groups = await Promise.all(memberships.map((m) => this.groups.findById(m.groupId)));
    return groups.filter((group) => group?.isActive).map((group) => group!.id);
  }
}
