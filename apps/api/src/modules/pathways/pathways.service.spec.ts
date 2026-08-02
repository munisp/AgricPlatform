import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCampusClubMembershipRepository,
  createInMemoryCampusClubRepository
} from '../../database/repositories/campus-club.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryPathwayEnrolmentRepository,
  createInMemoryStageProgressRepository
} from '../../database/repositories/pathway-enrolment.repository.js';
import {
  createInMemoryPathwayStageRepository,
  createInMemoryPathwayTemplateRepository
} from '../../database/repositories/pathway.repository.js';
import { PathwaysService } from './pathways.service.js';

const student: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  return new PathwaysService(
    events,
    createInMemoryPathwayTemplateRepository(),
    createInMemoryPathwayStageRepository(),
    createInMemoryPathwayEnrolmentRepository(),
    createInMemoryStageProgressRepository(),
    createInMemoryCampusClubRepository(),
    createInMemoryCampusClubMembershipRepository()
  );
}

async function makeTemplate(service: PathwaysService) {
  return service.createTemplate(
    {
      track: 'nysc',
      name: 'NYSC agribusiness pathway',
      stages: [
        { title: 'Orientation', requiredActions: ['attend briefing'] },
        { title: 'Field placement', requiredActions: ['log 40 hours'] },
        { title: 'Venture pitch', requiredActions: ['submit deck'] }
      ]
    },
    admin.id
  );
}

describe('PathwaysService templates', () => {
  it('creates templates with ordered stages', async () => {
    const service = makeService();
    const template = await makeTemplate(service);
    const detail = await service.getTemplate(template.id);
    expect(detail.stages.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(detail.stages[1].requiredActions).toEqual(['log 40 hours']);
  });

  it('rejects templates without stages', async () => {
    const service = makeService();
    await expect(
      service.createTemplate({ track: 'student', name: 'empty', stages: [] }, admin.id)
    ).rejects.toThrowError(BadRequestException);
  });
});

describe('PathwaysService enrolment and stage progression', () => {
  it('starts members on the first stage and advances with evidence', async () => {
    const service = makeService();
    const template = await makeTemplate(service);
    const enrolment = await service.enrol(template.id, student.id);
    const { stages } = await service.getTemplate(template.id);
    expect(enrolment.currentStageId).toBe(stages[0].id);

    const advanced = await service.completeCurrentStage(enrolment.id, 'briefing attended', student);
    expect(advanced.currentStageId).toBe(stages[1].id);
    expect(advanced.status).toBe('active');

    const { progress } = await service.getEnrolment(enrolment.id);
    expect(progress).toHaveLength(2);
    expect(progress.find((p) => p.stageId === stages[0].id)).toMatchObject({
      status: 'completed',
      evidence: 'briefing attended'
    });
  });

  it('completes the pathway after the last stage', async () => {
    const service = makeService();
    const template = await makeTemplate(service);
    const enrolment = await service.enrol(template.id, student.id);
    await service.completeCurrentStage(enrolment.id, 'e1', student);
    await service.completeCurrentStage(enrolment.id, 'e2', student);
    const done = await service.completeCurrentStage(enrolment.id, 'e3', student);
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeDefined();
    await expect(service.completeCurrentStage(enrolment.id, 'e4', student)).rejects.toThrowError(
      ConflictException
    );
  });

  it('requires evidence and ownership for stage completion', async () => {
    const service = makeService();
    const template = await makeTemplate(service);
    const enrolment = await service.enrol(template.id, student.id);
    await expect(service.completeCurrentStage(enrolment.id, '', student)).rejects.toThrowError(
      /evidence/
    );
    await expect(service.completeCurrentStage(enrolment.id, 'e', outsider)).rejects.toThrowError(
      ForbiddenException
    );
    expect((await service.completeCurrentStage(enrolment.id, 'e', admin)).status).toBe('active');
  });

  it('prevents duplicate active enrolments', async () => {
    const service = makeService();
    const template = await makeTemplate(service);
    await service.enrol(template.id, student.id);
    await expect(service.enrol(template.id, student.id)).rejects.toThrowError(ConflictException);
  });
});

describe('PathwaysService campus clubs', () => {
  it('registers clubs with the coordinator as first roster member', async () => {
    const service = makeService();
    const club = await service.createClub(
      {
        name: 'ABU Agripreneurs',
        institution: 'Ahmadu Bello University',
        state: 'Kaduna',
        coordinatorUserId: student.id,
        isNyscCdsGroup: false
      },
      admin.id
    );
    const detail = await service.getClub(club.id);
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0]).toMatchObject({ userId: student.id, role: 'coordinator' });
    expect((await service.getClub(club.id)).club.memberCount).toBe(1);
  });

  it('supports NYSC CDS groups and roster joins without duplicates', async () => {
    const service = makeService();
    const club = await service.createClub(
      {
        name: 'Ibadan CDS Agro',
        institution: 'University of Ibadan',
        state: 'Oyo',
        coordinatorUserId: admin.id,
        isNyscCdsGroup: true
      },
      admin.id
    );
    expect((await service.listClubs({ isNyscCdsGroup: true }))[0].id).toBe(club.id);
    expect((await service.listClubs({ isNyscCdsGroup: false }))).toHaveLength(0);
    await service.joinClub(club.id, student.id);
    await expect(service.joinClub(club.id, student.id)).rejects.toThrowError(ConflictException);
    expect((await service.getClub(club.id)).club.memberCount).toBe(2);
  });
});
