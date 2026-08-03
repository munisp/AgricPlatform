import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  FIELD_DATA_CAPTURE_CONSENT_PURPOSE,
  type Chapter,
  type User
} from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { InMemoryChapterRepository } from '../../database/repositories/chapter.repository.js';
import { createInMemoryComplianceConsentRepository } from '../../database/repositories/compliance.repository.js';
import {
  createInMemoryAgentActivityLogRepository,
  createInMemoryAgentAssignmentRepository,
  type InMemoryAgentActivityLogRepository,
  type InMemoryAgentAssignmentRepository
} from '../../database/repositories/field-agents.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { InMemoryUserRepository } from '../../database/repositories/user.repository.js';
import type { InMemoryComplianceConsentRepository } from '../../database/repositories/compliance.repository.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { FieldAgentsService } from './field-agents.service.js';

const enumerator: User = {
  id: 'user-agent-1',
  phone: '+2348070000001',
  fullName: 'Agent One',
  roles: ['enumerator'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const enumeratorTwo: User = {
  id: 'user-agent-2',
  phone: '+2348070000002',
  fullName: 'Agent Two',
  roles: ['enumerator'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const farmer: User = {
  id: 'user-agent-farmer',
  phone: '+2348070000003',
  fullName: 'Field Farmer',
  roles: ['farmer'],
  preferredLanguage: 'en',
  kycTier: 'tier_0',
  isVerified: false,
  createdAt: '2026-01-02T00:00:00.000Z'
};

const admin: User = {
  id: 'user-agent-admin',
  phone: '+2348070000004',
  fullName: 'Platform Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_3',
  isVerified: true,
  createdAt: '2026-01-03T00:00:00.000Z'
};

const lead: User = {
  id: 'user-agent-lead',
  phone: '+2348070000005',
  fullName: 'Kaduna Lead',
  roles: ['chapter_lead'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-03T00:00:00.000Z'
};

const otherLead: User = {
  id: 'user-agent-lead-2',
  phone: '+2348070000006',
  fullName: 'Kano Lead',
  roles: ['chapter_lead'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-03T00:00:00.000Z'
};

const chapters: Chapter[] = [
  {
    id: 'chapter-kd',
    name: 'Kaduna State Chapter',
    level: 'state',
    state: 'Kaduna',
    leadUserId: lead.id,
    memberCount: 10,
    active: true
  },
  {
    id: 'chapter-kn',
    name: 'Kano State Chapter',
    level: 'state',
    state: 'Kano',
    leadUserId: otherLead.id,
    memberCount: 12,
    active: true
  }
];

interface Harness {
  service: FieldAgentsService;
  assignments: InMemoryAgentAssignmentRepository;
  activity: InMemoryAgentActivityLogRepository;
  consents: InMemoryComplianceConsentRepository;
  profiles: InMemoryProfileRepository;
  events: Array<{ name: string; payload: unknown }>;
}

function harness(): Harness {
  const users = new UsersService(
    new InMemoryUserRepository([enumerator, enumeratorTwo, farmer, admin, lead, otherLead])
  );
  const events: Harness['events'] = [];
  const domainEvents = {
    publish: async (name: string, payload: unknown) => {
      events.push({ name, payload });
      return {};
    }
  } as unknown as DomainEventsService;
  const profiles = new InMemoryProfileRepository();
  const assignments = createInMemoryAgentAssignmentRepository();
  const activity = createInMemoryAgentActivityLogRepository();
  const consents = createInMemoryComplianceConsentRepository();
  const service = new FieldAgentsService(
    users,
    new ProfilesService(users, domainEvents, profiles),
    new AuditService(createInMemoryAuditRepository()),
    domainEvents,
    assignments,
    activity,
    new InMemoryChapterRepository(chapters),
    consents
  );
  return { service, assignments, activity, consents, profiles, events };
}

const CREATE_INPUT = {
  agentUserId: enumerator.id,
  state: 'Kaduna',
  lga: 'Zaria',
  purpose: 'farmer-registration',
  targetCount: 3
};

describe('FieldAgentsService — assignment lifecycle', () => {
  it('admin creates an assignment and the agent sees it in the queue', async () => {
    const h = harness();
    const created = await h.service.createAssignment(admin, CREATE_INPUT);
    expect(created.status).toBe('assigned');
    expect(created.completedCount).toBe(0);
    expect(created.createdBy).toBe(admin.id);
    const queue = await h.service.myQueue(enumerator);
    expect(queue.map((a) => a.id)).toEqual([created.id]);
    const log = await h.activity.find({ assignmentId: created.id, action: 'assignment_created' });
    expect(log).toHaveLength(1);
    expect(h.events.map((e) => e.name)).toContain('field-agents.assignment.created');
  });

  it('chapter lead creates an assignment in a chapter they lead', async () => {
    const h = harness();
    const created = await h.service.createAssignment(lead, {
      ...CREATE_INPUT,
      chapterId: 'chapter-kd'
    });
    expect(created.chapterId).toBe('chapter-kd');
  });

  it('chapter lead cannot create an assignment in a chapter they do not lead', async () => {
    const h = harness();
    await expect(
      h.service.createAssignment(lead, { ...CREATE_INPUT, chapterId: 'chapter-kn' })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects assignment creation for a user without the enumerator role', async () => {
    const h = harness();
    await expect(
      h.service.createAssignment(admin, { ...CREATE_INPUT, agentUserId: farmer.id })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enumerators and farmers cannot create assignments', async () => {
    const h = harness();
    await expect(h.service.createAssignment(enumerator, CREATE_INPUT)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(h.service.createAssignment(farmer, CREATE_INPUT)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(h.service.createAssignment(null, CREATE_INPUT)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('rejects invalid target counts and missing fields', async () => {
    const h = harness();
    await expect(
      h.service.createAssignment(admin, { ...CREATE_INPUT, targetCount: 0 })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.createAssignment(admin, { ...CREATE_INPUT, state: ' ' })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('progress increments completed_count and flips to in_progress', async () => {
    const h = harness();
    const created = await h.service.createAssignment(admin, CREATE_INPUT);
    const updated = await h.service.reportProgress(enumerator, created.id);
    expect(updated.completedCount).toBe(1);
    expect(updated.status).toBe('in_progress');
  });

  it('auto-completes when the target is reached and caps the count', async () => {
    const h = harness();
    const created = await h.service.createAssignment(admin, CREATE_INPUT);
    await h.service.reportProgress(enumerator, created.id);
    const done = await h.service.reportProgress(enumerator, created.id, 5);
    expect(done.completedCount).toBe(3);
    expect(done.status).toBe('completed');
    const completedLog = await h.activity.find({
      assignmentId: created.id,
      action: 'assignment_completed'
    });
    expect(completedLog).toHaveLength(1);
    expect(h.events.map((e) => e.name)).toContain('field-agents.assignment.completed');
    // Completed work leaves the enumerator's queue.
    expect(await h.service.myQueue(enumerator)).toHaveLength(0);
  });

  it('rejects progress on completed or cancelled assignments', async () => {
    const h = harness();
    const created = await h.service.createAssignment(admin, { ...CREATE_INPUT, targetCount: 1 });
    await h.service.reportProgress(enumerator, created.id);
    await expect(h.service.reportProgress(enumerator, created.id)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it("an enumerator cannot report progress on another agent's assignment", async () => {
    const h = harness();
    const created = await h.service.createAssignment(admin, CREATE_INPUT);
    await expect(h.service.reportProgress(enumeratorTwo, created.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('progress on an unknown assignment is a 404', async () => {
    const h = harness();
    await expect(h.service.reportProgress(enumerator, 'asgn-missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('cancel transitions an open assignment and blocks further progress', async () => {
    const h = harness();
    const created = await h.service.createAssignment(admin, CREATE_INPUT);
    const cancelled = await h.service.cancel(admin, created.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(h.service.reportProgress(enumerator, created.id)).rejects.toBeInstanceOf(
      ConflictException
    );
    await expect(h.service.cancel(admin, created.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('chapter lead can cancel only assignments they created or in their chapters', async () => {
    const h = harness();
    const own = await h.service.createAssignment(lead, {
      ...CREATE_INPUT,
      chapterId: 'chapter-kd'
    });
    const other = await h.service.createAssignment(admin, {
      ...CREATE_INPUT,
      chapterId: 'chapter-kn'
    });
    await expect(h.service.cancel(lead, own.id)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(h.service.cancel(lead, other.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('FieldAgentsService — listing scoping', () => {
  it('admin sees everything; enumerators cannot list', async () => {
    const h = harness();
    await h.service.createAssignment(admin, CREATE_INPUT);
    await h.service.createAssignment(lead, { ...CREATE_INPUT, chapterId: 'chapter-kd' });
    expect(await h.service.listAssignments(admin, {})).toHaveLength(2);
    await expect(h.service.listAssignments(enumerator, {})).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('chapter lead list is scoped to own creations and led chapters', async () => {
    const h = harness();
    await h.service.createAssignment(admin, { ...CREATE_INPUT, chapterId: 'chapter-kn' });
    await h.service.createAssignment(admin, { ...CREATE_INPUT, chapterId: 'chapter-kd' });
    await h.service.createAssignment(lead, CREATE_INPUT);
    const visible = await h.service.listAssignments(lead, {});
    expect(visible).toHaveLength(2);
    expect(
      visible.every((a) => a.createdBy === lead.id || a.chapterId === 'chapter-kd')
    ).toBe(true);
  });

  it('filters by agent and status', async () => {
    const h = harness();
    await h.service.createAssignment(admin, CREATE_INPUT);
    await h.service.createAssignment(admin, { ...CREATE_INPUT, agentUserId: enumeratorTwo.id });
    const forAgent = await h.service.listAssignments(admin, { agentUserId: enumeratorTwo.id });
    expect(forAgent).toHaveLength(1);
    expect(await h.service.listAssignments(admin, { status: 'completed' })).toHaveLength(0);
  });

  it("an enumerator's queue hides other agents' work", async () => {
    const h = harness();
    await h.service.createAssignment(admin, CREATE_INPUT);
    expect(await h.service.myQueue(enumeratorTwo)).toHaveLength(0);
    await expect(h.service.myQueue(farmer)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('FieldAgentsService — on-behalf capture', () => {
  it('captures a profile by farmer phone, attributes the agent and records consent', async () => {
    const h = harness();
    const result = await h.service.captureProfile(enumerator, {
      farmerPhone: farmer.phone,
      location: { state: 'Kaduna', lga: 'Zaria', ward: 'Tudun Wada' },
      farmingInterests: ['Maize'],
      valueChains: ['Maize'],
      bio: 'Registered in the field by an enumerator during the Kaduna drive.'
    });
    expect(result.farmerUserId).toBe(farmer.id);
    expect(result.capturedBy).toBe(enumerator.id);
    expect(result.profile.location.state).toBe('Kaduna');
    // Consent recorded for the FARMER with the field-data-capture purpose.
    const consents = await h.consents.findByUser(farmer.id);
    expect(consents).toHaveLength(1);
    expect(consents[0].purpose).toBe(FIELD_DATA_CAPTURE_CONSENT_PURPOSE);
    expect(consents[0].id).toBe(result.consentId);
    expect(consents[0].source).toBe('field-agent-capture');
    // Attribution in the activity log (profiles tables are not modified).
    const log = await h.activity.find({ action: 'profile_captured', subjectUserId: farmer.id });
    expect(log).toHaveLength(1);
    expect(log[0].agentUserId).toBe(enumerator.id);
    expect(log[0].meta.consentId).toBe(result.consentId);
    expect(h.events.map((e) => e.name)).toContain('field-agents.profile.captured');
  });

  it('upserts through the profiles service (merges with the existing profile)', async () => {
    const h = harness();
    await h.service.captureProfile(enumerator, {
      farmerUserId: farmer.id,
      bio: 'First capture with a sufficiently long biography text.'
    });
    const second = await h.service.captureProfile(enumerator, {
      farmerUserId: farmer.id,
      farmSizeHectares: 2.5
    });
    expect(second.profile.bio).toContain('First capture');
    expect(second.profile.farmSizeHectares).toBe(2.5);
    expect(await h.consents.findByUser(farmer.id)).toHaveLength(2);
  });

  it('non-enumerators cannot capture on behalf of farmers', async () => {
    const h = harness();
    await expect(
      h.service.captureProfile(admin, { farmerUserId: farmer.id })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.service.captureProfile(farmer, { farmerUserId: farmer.id })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed without a farmer reference or for an unknown phone', async () => {
    const h = harness();
    await expect(h.service.captureProfile(enumerator, {})).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      h.service.captureProfile(enumerator, { farmerPhone: '+2348000000000' })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FieldAgentsService — productivity', () => {
  it('aggregates per-agent completion rates (admin only)', async () => {
    const h = harness();
    const first = await h.service.createAssignment(admin, { ...CREATE_INPUT, targetCount: 2 });
    await h.service.createAssignment(admin, { ...CREATE_INPUT, targetCount: 2 });
    const third = await h.service.createAssignment(admin, {
      ...CREATE_INPUT,
      agentUserId: enumeratorTwo.id,
      targetCount: 4
    });
    await h.service.reportProgress(enumerator, first.id, 2);
    await h.service.reportProgress(enumeratorTwo, third.id);
    await h.service.cancel(admin, third.id);

    const rows = await h.service.productivity(admin);
    expect(rows).toHaveLength(2);
    const one = rows.find((row) => row.agentUserId === enumerator.id)!;
    expect(one.totalAssignments).toBe(2);
    expect(one.completedAssignments).toBe(1);
    expect(one.targetCount).toBe(4);
    expect(one.completedCount).toBe(2);
    expect(one.completionRate).toBe(0.5);
    const two = rows.find((row) => row.agentUserId === enumeratorTwo.id)!;
    // Cancelled assignments contribute no target/completed counts.
    expect(two.cancelledAssignments).toBe(1);
    expect(two.targetCount).toBe(0);
    expect(two.completionRate).toBe(0);

    await expect(h.service.productivity(lead)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.productivity(enumerator)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
