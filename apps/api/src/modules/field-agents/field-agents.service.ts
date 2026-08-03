import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import {
  FIELD_DATA_CAPTURE_CONSENT_PURPOSE,
  type AgentActivityLogEntry,
  type AgentAssignment,
  type AgentProductivity,
  type LocationRef,
  type Profile,
  type User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_ACTIVITY_LOG_REPOSITORY,
  AGENT_ASSIGNMENT_REPOSITORY,
  CHAPTER_REPOSITORY,
  COMPLIANCE_CONSENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type { ComplianceConsentRepository } from '../../database/repositories/compliance.repository.js';
import type {
  AgentActivityLogRepository,
  AgentAssignmentCriteria,
  AgentAssignmentRepository
} from '../../database/repositories/field-agents.repository.js';
import { ProfilesService, type UpsertProfileInput } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';

export interface CreateAssignmentInput {
  agentUserId: string;
  farmerUserId?: string;
  chapterId?: string;
  state: string;
  lga: string;
  ward?: string;
  purpose: string;
  targetCount?: number;
  dueAt?: string;
}

export interface ListAssignmentsFilter {
  agentUserId?: string;
  status?: AgentAssignment['status'];
  state?: string;
  chapterId?: string;
}

export interface CaptureProfileInput {
  farmerUserId?: string;
  farmerPhone?: string;
  location?: LocationRef;
  farmingInterests?: string[];
  valueChains?: string[];
  bio?: string;
  farmSizeHectares?: number;
  yearsExperience?: number;
  /** Version label of the consent text read to the farmer in the field. */
  policyVersion?: string;
}

export interface CaptureProfileResult {
  profile: Profile;
  farmerUserId: string;
  consentId: string;
  capturedBy: string;
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for this resource');
  }
  return actor;
}

function requireEnumerator(actor: User | null): User {
  const user = requireUser(actor);
  if (!user.roles.includes('enumerator')) {
    throw new ForbiddenException('Enumerator role required');
  }
  return user;
}

function requireAdminOrChapterLead(actor: User | null): User {
  const user = requireUser(actor);
  if (!user.roles.includes('admin') && !user.roles.includes('chapter_lead')) {
    throw new ForbiddenException('Administrator or chapter lead role required');
  }
  return user;
}

function requireAdmin(actor: User | null): User {
  const user = requireUser(actor);
  if (!user.roles.includes('admin')) {
    throw new ForbiddenException('Administrator role required');
  }
  return user;
}

/**
 * Wave AGENTS field-agent (enumerator) workflows: assignment lifecycle
 * (create → progress → auto-complete at target / cancel), the enumerator's
 * queue, on-behalf profile capture with a 'field-data-capture' consent record
 * (compliance port, migration 021) and per-agent productivity aggregates.
 * Every action appends to the agents.agent_activity_log trail AND the audit
 * hash chain + domain-event outbox.
 */
@Injectable()
export class FieldAgentsService {
  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(AGENT_ASSIGNMENT_REPOSITORY)
    private readonly assignments: AgentAssignmentRepository,
    @Inject(AGENT_ACTIVITY_LOG_REPOSITORY)
    private readonly activity: AgentActivityLogRepository,
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(COMPLIANCE_CONSENT_REPOSITORY)
    private readonly consents: ComplianceConsentRepository
  ) {}

  // ------------------------------------------------------------ assignments

  async createAssignment(
    actor: User | null,
    input: CreateAssignmentInput
  ): Promise<AgentAssignment> {
    const creator = requireAdminOrChapterLead(actor);
    if (!input.state?.trim() || !input.lga?.trim() || !input.purpose?.trim()) {
      throw new BadRequestException('state, lga and purpose are required');
    }
    const targetCount = input.targetCount ?? 1;
    if (!Number.isInteger(targetCount) || targetCount < 1) {
      throw new BadRequestException('targetCount must be an integer >= 1');
    }
    const agent = await this.users.getById(input.agentUserId);
    if (!agent.roles.includes('enumerator')) {
      throw new BadRequestException(
        `User '${input.agentUserId}' does not have the enumerator role`
      );
    }
    if (input.farmerUserId) {
      await this.users.getById(input.farmerUserId);
    }
    if (input.chapterId) {
      const chapter = await this.chapters.getById(input.chapterId);
      // Chapter leads may only assign work inside chapters they lead.
      if (!creator.roles.includes('admin') && chapter.leadUserId !== creator.id) {
        throw new ForbiddenException('Chapter leads can only assign work in chapters they lead');
      }
    }
    const now = new Date().toISOString();
    const assignment = await this.assignments.create({
      id: newId('asgn'),
      agentUserId: input.agentUserId,
      ...(input.farmerUserId ? { farmerUserId: input.farmerUserId } : {}),
      ...(input.chapterId ? { chapterId: input.chapterId } : {}),
      state: input.state,
      lga: input.lga,
      ...(input.ward ? { ward: input.ward } : {}),
      purpose: input.purpose,
      targetCount,
      completedCount: 0,
      status: 'assigned',
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdBy: creator.id,
      createdAt: now,
      updatedAt: now
    });
    await this.logActivity(agent.id, 'assignment_created', {
      assignmentId: assignment.id,
      subjectUserId: input.farmerUserId,
      meta: { purpose: assignment.purpose, targetCount, createdBy: creator.id }
    });
    await this.audit.record({
      actorId: creator.id,
      action: 'field_agents.assignment_created',
      entityType: 'agent_assignment',
      entityId: assignment.id,
      metadata: { agentUserId: agent.id, purpose: assignment.purpose, targetCount }
    });
    await this.events.publish(
      'field-agents.assignment.created',
      { assignmentId: assignment.id, agentUserId: agent.id, targetCount },
      creator.id
    );
    return assignment;
  }

  /** The enumerator's queue: open (assigned / in_progress) assignments only. */
  async myQueue(actor: User | null): Promise<AgentAssignment[]> {
    const agent = requireEnumerator(actor);
    const mine = await this.assignments.find({ agentUserId: agent.id });
    return mine.filter(
      (assignment) => assignment.status === 'assigned' || assignment.status === 'in_progress'
    );
  }

  /**
   * Increments completed_count (default +1, capped at the target) and
   * auto-completes the assignment when the target is reached. Only the
   * assigned enumerator may report progress.
   */
  async reportProgress(
    actor: User | null,
    assignmentId: string,
    count = 1
  ): Promise<AgentAssignment> {
    const agent = requireEnumerator(actor);
    if (!Number.isInteger(count) || count < 1) {
      throw new BadRequestException('count must be an integer >= 1');
    }
    const assignment = await this.assignments.getById(assignmentId);
    if (assignment.agentUserId !== agent.id) {
      throw new ForbiddenException('Only the assigned enumerator can report progress');
    }
    if (assignment.status === 'completed' || assignment.status === 'cancelled') {
      throw new ConflictException(`Assignment '${assignmentId}' is ${assignment.status}`);
    }
    const completedCount = Math.min(assignment.targetCount, assignment.completedCount + count);
    const completed = completedCount >= assignment.targetCount;
    const updated = await this.assignments.update(assignmentId, {
      completedCount,
      status: completed ? 'completed' : 'in_progress',
      updatedAt: new Date().toISOString()
    });
    await this.logActivity(agent.id, 'assignment_progress', {
      assignmentId,
      subjectUserId: assignment.farmerUserId,
      meta: { delta: count, completedCount, targetCount: assignment.targetCount }
    });
    if (completed) {
      await this.logActivity(agent.id, 'assignment_completed', {
        assignmentId,
        subjectUserId: assignment.farmerUserId,
        meta: { targetCount: assignment.targetCount }
      });
    }
    await this.audit.record({
      actorId: agent.id,
      action: completed
        ? 'field_agents.assignment_completed'
        : 'field_agents.assignment_progress',
      entityType: 'agent_assignment',
      entityId: assignmentId,
      metadata: { completedCount, targetCount: assignment.targetCount }
    });
    await this.events.publish(
      completed ? 'field-agents.assignment.completed' : 'field-agents.assignment.progress',
      { assignmentId, agentUserId: agent.id, completedCount },
      agent.id
    );
    return updated;
  }

  /**
   * Admin/chapter-lead listing. Chapter leads see only assignments they
   * created or that belong to chapters they lead.
   */
  async listAssignments(
    actor: User | null,
    filter: ListAssignmentsFilter
  ): Promise<AgentAssignment[]> {
    const user = requireAdminOrChapterLead(actor);
    const criteria: AgentAssignmentCriteria = {
      ...(filter.agentUserId ? { agentUserId: filter.agentUserId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.chapterId ? { chapterId: filter.chapterId } : {})
    };
    const all = await this.assignments.find(criteria);
    if (user.roles.includes('admin')) {
      return all;
    }
    const ledChapterIds = await this.ledChapterIds(user.id);
    return all.filter(
      (assignment) =>
        assignment.createdBy === user.id ||
        (assignment.chapterId !== undefined && ledChapterIds.has(assignment.chapterId))
    );
  }

  async cancel(actor: User | null, assignmentId: string): Promise<AgentAssignment> {
    const user = requireAdminOrChapterLead(actor);
    const assignment = await this.assignments.getById(assignmentId);
    if (!user.roles.includes('admin')) {
      const ledChapterIds = await this.ledChapterIds(user.id);
      const inScope =
        assignment.createdBy === user.id ||
        (assignment.chapterId !== undefined && ledChapterIds.has(assignment.chapterId));
      if (!inScope) {
        throw new ForbiddenException(
          'Chapter leads can only cancel assignments they created or in chapters they lead'
        );
      }
    }
    if (assignment.status === 'completed' || assignment.status === 'cancelled') {
      throw new ConflictException(`Assignment '${assignmentId}' is ${assignment.status}`);
    }
    const updated = await this.assignments.update(assignmentId, {
      status: 'cancelled',
      updatedAt: new Date().toISOString()
    });
    await this.logActivity(assignment.agentUserId, 'assignment_cancelled', {
      assignmentId,
      subjectUserId: assignment.farmerUserId,
      meta: { cancelledBy: user.id }
    });
    await this.audit.record({
      actorId: user.id,
      action: 'field_agents.assignment_cancelled',
      entityType: 'agent_assignment',
      entityId: assignmentId,
      metadata: { agentUserId: assignment.agentUserId }
    });
    await this.events.publish(
      'field-agents.assignment.cancelled',
      { assignmentId, agentUserId: assignment.agentUserId },
      user.id
    );
    return updated;
  }

  // ----------------------------------------------------------- productivity

  /** Admin-only per-agent completion aggregates. */
  async productivity(actor: User | null): Promise<AgentProductivity[]> {
    requireAdmin(actor);
    const agentIds = await this.assignments.listAgentIds();
    const rows: AgentProductivity[] = [];
    for (const agentUserId of agentIds) {
      const mine = await this.assignments.find({ agentUserId });
      const active = mine.filter((a) => a.status === 'assigned' || a.status === 'in_progress');
      const completedAssignments = mine.filter((a) => a.status === 'completed');
      // Productivity counts real work: cancelled rows contribute neither
      // targets nor completions.
      const counted = mine.filter((a) => a.status !== 'cancelled');
      const targetCount = counted.reduce((sum, a) => sum + a.targetCount, 0);
      const completedCount = counted.reduce((sum, a) => sum + a.completedCount, 0);
      rows.push({
        agentUserId,
        totalAssignments: mine.length,
        activeAssignments: active.length,
        completedAssignments: completedAssignments.length,
        cancelledAssignments: mine.length - counted.length,
        targetCount,
        completedCount,
        completionRate: targetCount > 0 ? completedCount / targetCount : 0
      });
    }
    return rows;
  }

  // -------------------------------------------------------- on-behalf capture

  /**
   * Enumerator captures/updates a farmer's profile on their behalf. The
   * capture goes through the profiles service (same merge/completion logic as
   * self-service), records a 'field-data-capture' consent for the FARMER via
   * the compliance consent port (NDPA lawful-basis trail) and attributes the
   * capture to the agent in the activity log (profiles tables are untouched).
   */
  async captureProfile(
    actor: User | null,
    input: CaptureProfileInput
  ): Promise<CaptureProfileResult> {
    const agent = requireEnumerator(actor);
    const farmer = await this.resolveFarmer(input);
    const profileInput: UpsertProfileInput = {
      ...(input.location ? { location: input.location } : {}),
      ...(input.farmingInterests ? { farmingInterests: input.farmingInterests } : {}),
      ...(input.valueChains ? { valueChains: input.valueChains } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      ...(input.farmSizeHectares !== undefined ? { farmSizeHectares: input.farmSizeHectares } : {}),
      ...(input.yearsExperience !== undefined ? { yearsExperience: input.yearsExperience } : {})
    };
    const profile = await this.profiles.upsert(farmer.id, profileInput);
    const consent = await this.consents.create({
      id: newId('consent'),
      userId: farmer.id,
      purpose: FIELD_DATA_CAPTURE_CONSENT_PURPOSE,
      policyVersion: input.policyVersion ?? 'field-capture-v1',
      grantedAt: new Date().toISOString(),
      source: 'field-agent-capture'
    });
    await this.logActivity(agent.id, 'profile_captured', {
      subjectUserId: farmer.id,
      meta: {
        capturedBy: agent.id,
        consentId: consent.id,
        purpose: FIELD_DATA_CAPTURE_CONSENT_PURPOSE,
        fields: Object.keys(profileInput)
      }
    });
    await this.audit.record({
      actorId: agent.id,
      action: 'field_agents.profile_captured',
      entityType: 'profile',
      entityId: farmer.id,
      metadata: {
        capturedBy: agent.id,
        consentId: consent.id,
        fields: Object.keys(profileInput)
      }
    });
    await this.events.publish(
      'field-agents.profile.captured',
      { farmerUserId: farmer.id, capturedBy: agent.id, consentId: consent.id },
      agent.id
    );
    return { profile, farmerUserId: farmer.id, consentId: consent.id, capturedBy: agent.id };
  }

  // ---------------------------------------------------------------- helpers

  private async resolveFarmer(input: CaptureProfileInput): Promise<User> {
    if (input.farmerUserId) {
      return this.users.getById(input.farmerUserId);
    }
    if (input.farmerPhone) {
      const farmer = await this.users.findByPhone(input.farmerPhone);
      if (!farmer) {
        throw new NotFoundException(`No user with phone '${input.farmerPhone}'`);
      }
      return farmer;
    }
    throw new BadRequestException('farmerUserId or farmerPhone is required');
  }

  private async ledChapterIds(userId: string): Promise<Set<string>> {
    const chapters = await this.chapters.all();
    return new Set(
      chapters.filter((chapter) => chapter.leadUserId === userId).map((chapter) => chapter.id)
    );
  }

  private async logActivity(
    agentUserId: string,
    action: string,
    options: { assignmentId?: string; subjectUserId?: string; meta: Record<string, unknown> }
  ): Promise<AgentActivityLogEntry> {
    return this.activity.append({
      id: newId('agact'),
      agentUserId,
      ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
      action,
      ...(options.subjectUserId ? { subjectUserId: options.subjectUserId } : {}),
      meta: options.meta,
      createdAt: new Date().toISOString()
    });
  }
}
