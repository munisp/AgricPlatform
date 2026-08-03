import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type { CreditGroup, CreditGroupMember, CreditGroupRole } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CreditGroupMemberRepository,
  CreditGroupRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { CreditActor } from './credit.service.js';

export interface CreateCreditGroupInput {
  name: string;
  chapterId?: string;
}

export interface CreditGroupWithMembers {
  group: CreditGroup;
  members: CreditGroupMember[];
}

/**
 * VSLA/chama group management (Wave CREDIT). The creator becomes the group
 * leader; leaders administer membership. Group loans and group savings are
 * anchored on these groups (see CreditService.applyForGroup and
 * CreditSavingsService).
 */
@Injectable()
export class CreditGroupsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CREDIT_GROUP_REPOSITORY) private readonly groups: CreditGroupRepository,
    @Inject(CREDIT_GROUP_MEMBER_REPOSITORY) private readonly members: CreditGroupMemberRepository,
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
      createdAt: new Date().toISOString()
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

  async listGroups(): Promise<CreditGroup[]> {
    return this.groups.find({});
  }

  async getGroup(groupId: string): Promise<CreditGroupWithMembers> {
    const group = await this.groups.getById(groupId);
    const members = await this.members.listByGroup(groupId);
    return { group, members };
  }

  async listMyGroups(actor: CreditActor): Promise<CreditGroupWithMembers[]> {
    const memberships = await this.members.listByUser(actor.id);
    const result: CreditGroupWithMembers[] = [];
    for (const membership of memberships) {
      result.push(await this.getGroup(membership.groupId));
    }
    return result;
  }

  /** Self-join as a member (idempotent). */
  async join(groupId: string, actor: CreditActor): Promise<CreditGroupMember> {
    await this.groups.getById(groupId);
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
   * Self-leave. The leader may not leave while other members remain (the
   * group would be orphaned); remove the members or dissolve first.
   */
  async leave(groupId: string, actor: CreditActor): Promise<void> {
    const membership = await this.members.find(groupId, actor.id);
    if (!membership) {
      return; // idempotent
    }
    if (membership.role === 'leader' && (await this.members.countByGroup(groupId)) > 1) {
      throw new BadRequestException(
        'The group leader cannot leave while other members remain'
      );
    }
    await this.members.remove(groupId, actor.id);
    await this.events.publish('credit.group.member_left', { groupId, userId: actor.id }, actor.id);
  }

  /** Leader (or admin) adds another user as a member. */
  async addMember(groupId: string, userId: string, actor: CreditActor): Promise<CreditGroupMember> {
    await this.requireLeader(groupId, actor);
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
