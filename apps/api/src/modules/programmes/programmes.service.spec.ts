import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ProgrammeCohort, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCohortThreadPostRepository,
  createInMemoryCohortThreadRepository
} from '../../database/repositories/cohort-thread.repository.js';
import {
  createInMemoryJudgeAssignmentRepository,
  createInMemoryJudgeScoreRepository,
  createInMemoryRubricCriterionRepository
} from '../../database/repositories/judging.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryProgrammeCohortRepository } from '../../database/repositories/programme-cohort.repository.js';
import { createInMemoryProgrammeEnrolmentRepository } from '../../database/repositories/programme-enrolment.repository.js';
import {
  createInMemoryMilestoneProgressRepository,
  createInMemoryProgrammeMilestoneRepository
} from '../../database/repositories/programme-milestone.repository.js';
import { ProgrammesService } from './programmes.service.js';

const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const member: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };
const other: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const moderator: Pick<User, 'id' | 'roles'> = { id: 'user-mod', roles: ['partner'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  return new ProgrammesService(
    events,
    createInMemoryProgrammeCohortRepository(),
    createInMemoryProgrammeEnrolmentRepository(),
    createInMemoryProgrammeMilestoneRepository(),
    createInMemoryMilestoneProgressRepository(),
    createInMemoryRubricCriterionRepository(),
    createInMemoryJudgeAssignmentRepository(),
    createInMemoryJudgeScoreRepository(),
    createInMemoryCohortThreadRepository(),
    createInMemoryCohortThreadPostRepository()
  );
}

const WINDOW = {
  enrolmentOpensAt: '2026-01-01T00:00:00.000Z',
  enrolmentClosesAt: '2026-12-31T23:59:59.000Z'
};
const INSIDE_WINDOW = new Date('2026-06-01T00:00:00.000Z');

async function openCohort(
  service: ProgrammesService,
  programmeType: 'women' | 'youth' = 'women',
  capacity = 2
): Promise<ProgrammeCohort> {
  const cohort = await service.createCohort(
    {
      name: `${programmeType} cohort`,
      programmeType,
      capacity,
      moderatorIds: [moderator.id],
      ...WINDOW
    },
    admin.id
  );
  return service.setCohortStatus(cohort.id, 'open', admin.id);
}

describe('ProgrammesService own enrolments list', () => {
  it('returns only the user\'s enrolments with cohort and milestone progress summary', async () => {
    const service = makeService();
    const cohort = await openCohort(service);
    const first = await service.addMilestone(cohort.id, { title: 'Baseline survey', sequence: 1 }, admin.id);
    await service.addMilestone(cohort.id, { title: 'Business plan', sequence: 2 }, admin.id);
    const mine = await service.enrol(
      cohort.id,
      { userId: member.id, declaredGender: 'female' },
      INSIDE_WINDOW
    );
    await service.enrol(cohort.id, { userId: other.id, declaredGender: 'female' }, INSIDE_WINDOW);
    await service.setMilestoneProgress(first.id, member.id, 'completed', member);

    const summaries = await service.listMyEnrolments(member.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].enrolment.id).toBe(mine.id);
    expect(summaries[0].cohort.id).toBe(cohort.id);
    expect(summaries[0].milestonesTotal).toBe(2);
    expect(summaries[0].milestonesCompleted).toBe(1);

    // Ownership scoping: the other member's enrolment never leaks.
    const othersSummaries = await service.listMyEnrolments(other.id);
    expect(othersSummaries).toHaveLength(1);
    expect(othersSummaries[0].enrolment.userId).toBe(other.id);
    expect(othersSummaries[0].milestonesCompleted).toBe(0);
    expect(await service.listMyEnrolments('user-unknown')).toEqual([]);
  });
});

describe('ProgrammesService cohort lifecycle', () => {
  it('walks draft → open → closed → active → completed and rejects skips', async () => {
    const service = makeService();
    const cohort = await service.createCohort(
      { name: 'c', programmeType: 'youth', capacity: 10, ...WINDOW },
      admin.id
    );
    expect(cohort.status).toBe('draft');
    await expect(service.setCohortStatus(cohort.id, 'active', admin.id)).rejects.toThrowError(
      /Invalid cohort transition/
    );
    await service.setCohortStatus(cohort.id, 'open', admin.id);
    await service.setCohortStatus(cohort.id, 'closed', admin.id);
    await service.setCohortStatus(cohort.id, 'active', admin.id);
    expect((await service.setCohortStatus(cohort.id, 'completed', admin.id)).status).toBe('completed');
    await expect(service.setCohortStatus(cohort.id, 'open', admin.id)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('rejects an inverted enrolment window', async () => {
    const service = makeService();
    await expect(
      service.createCohort(
        {
          name: 'bad',
          programmeType: 'women',
          capacity: 1,
          enrolmentOpensAt: '2026-12-31T00:00:00.000Z',
          enrolmentClosesAt: '2026-01-01T00:00:00.000Z'
        },
        admin.id
      )
    ).rejects.toThrowError(BadRequestException);
  });
});

describe('ProgrammesService enrolment', () => {
  it('enforces the declared-gender eligibility for women cohorts', async () => {
    const service = makeService();
    const cohort = await openCohort(service, 'women');
    await expect(
      service.enrol(cohort.id, { userId: other.id, declaredGender: 'male' }, INSIDE_WINDOW)
    ).rejects.toThrowError(ForbiddenException);
    const enrolment = await service.enrol(
      cohort.id,
      { userId: member.id, declaredGender: 'female' },
      INSIDE_WINDOW
    );
    expect(enrolment.status).toBe('enrolled');
  });

  it('enforces the youth age band on declared age', async () => {
    const service = makeService();
    const cohort = await openCohort(service, 'youth');
    await expect(
      service.enrol(cohort.id, { userId: member.id, declaredAge: 17 }, INSIDE_WINDOW)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      service.enrol(cohort.id, { userId: member.id, declaredAge: 36 }, INSIDE_WINDOW)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      service.enrol(cohort.id, { userId: member.id }, INSIDE_WINDOW)
    ).rejects.toThrowError(/declared age/);
    expect(
      (await service.enrol(cohort.id, { userId: member.id, declaredAge: 18 }, INSIDE_WINDOW)).status
    ).toBe('enrolled');
    expect(
      (await service.enrol(cohort.id, { userId: other.id, declaredAge: 35 }, INSIDE_WINDOW)).status
    ).toBe('enrolled');
  });

  it('enforces window, open status, duplicates and capacity', async () => {
    const service = makeService();
    const draft = await service.createCohort(
      { name: 'c', programmeType: 'youth', capacity: 1, ...WINDOW },
      admin.id
    );
    await expect(
      service.enrol(draft.id, { userId: member.id, declaredAge: 20 }, INSIDE_WINDOW)
    ).rejects.toThrowError(ConflictException);
    const cohort = await service.setCohortStatus(draft.id, 'open', admin.id);
    await expect(
      service.enrol(cohort.id, { userId: member.id, declaredAge: 20 }, new Date('2027-06-01T00:00:00.000Z'))
    ).rejects.toThrowError(/window/);
    await service.enrol(cohort.id, { userId: member.id, declaredAge: 20 }, INSIDE_WINDOW);
    await expect(
      service.enrol(cohort.id, { userId: member.id, declaredAge: 20 }, INSIDE_WINDOW)
    ).rejects.toThrowError(/already enrolled/);
    await expect(
      service.enrol(cohort.id, { userId: other.id, declaredAge: 22 }, INSIDE_WINDOW)
    ).rejects.toThrowError(/capacity/);
  });
});

describe('ProgrammesService milestones', () => {
  it('tracks per-member progress and guards ownership', async () => {
    const service = makeService();
    const cohort = await openCohort(service, 'youth');
    await service.enrol(cohort.id, { userId: member.id, declaredAge: 24 }, INSIDE_WINDOW);
    const milestone = await service.addMilestone(cohort.id, { title: 'Business plan', sequence: 1 }, admin.id);
    const progress = await service.setMilestoneProgress(milestone.id, member.id, 'in_progress', member);
    expect(progress.status).toBe('in_progress');
    const completed = await service.setMilestoneProgress(milestone.id, member.id, 'completed', member);
    expect(completed.completedAt).toBeDefined();
    expect(await service.progressForUser(cohort.id, member.id)).toHaveLength(1);
    await expect(
      service.setMilestoneProgress(milestone.id, member.id, 'completed', outsider)
    ).rejects.toThrowError(ForbiddenException);
  });
});

describe('ProgrammesService judging', () => {
  async function judgingSetup() {
    const service = makeService();
    const cohort = await openCohort(service, 'women', 5);
    await service.enrol(cohort.id, { userId: member.id, declaredGender: 'female' }, INSIDE_WINDOW);
    await service.enrol(cohort.id, { userId: 'user-fatima', declaredGender: 'female' }, INSIDE_WINDOW);
    const criterion = await service.addRubricCriterion(cohort.id, { name: 'Innovation', maxScore: 10 }, admin.id);
    await service.assignJudge(cohort.id, other.id, admin.id);
    return { service, cohort, criterion };
  }

  it('rejects scores from non-judges and scores above the criterion max', async () => {
    const { service, cohort, criterion } = await judgingSetup();
    await expect(
      service.submitScore(cohort.id, outsider.id, member.id, criterion.id, 5)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      service.submitScore(cohort.id, other.id, member.id, criterion.id, 11)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      service.submitScore(cohort.id, other.id, outsider.id, criterion.id, 5)
    ).rejects.toThrowError(/enrolled/);
  });

  it('enforces uniqueness per judge + entry + criterion', async () => {
    const { service, cohort, criterion } = await judgingSetup();
    await service.submitScore(cohort.id, other.id, member.id, criterion.id, 8);
    await expect(
      service.submitScore(cohort.id, other.id, member.id, criterion.id, 9)
    ).rejects.toThrowError(ConflictException);
  });

  it('computes the leaderboard with totals, judge counts and ranks', async () => {
    const { service, cohort, criterion } = await judgingSetup();
    const second = await service.addRubricCriterion(cohort.id, { name: 'Impact', maxScore: 10 }, admin.id);
    await service.assignJudge(cohort.id, moderator.id, admin.id);
    await service.submitScore(cohort.id, other.id, member.id, criterion.id, 6);
    await service.submitScore(cohort.id, other.id, member.id, second.id, 8);
    await service.submitScore(cohort.id, moderator.id, member.id, criterion.id, 10);
    await service.submitScore(cohort.id, other.id, 'user-fatima', criterion.id, 9);
    const board = await service.leaderboard(cohort.id);
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ entryUserId: member.id, totalScore: 24, judgeCount: 2, rank: 1 });
    expect(board[0].averageScore).toBe(12);
    expect(board[1]).toMatchObject({ entryUserId: 'user-fatima', totalScore: 9, rank: 2 });
  });
});

describe('ProgrammesService protected spaces', () => {
  it('denies non-members and allows enrolled members, moderators and admins', async () => {
    const service = makeService();
    const cohort = await openCohort(service, 'youth');
    await service.enrol(cohort.id, { userId: member.id, declaredAge: 25 }, INSIDE_WINDOW);
    await expect(service.listThreads(cohort.id, outsider)).rejects.toThrowError(ForbiddenException);
    await expect(service.createThread(cohort.id, 'hi', outsider)).rejects.toThrowError(
      /Protected space/
    );
    const thread = await service.createThread(cohort.id, 'Welcome', member);
    expect((await service.listThreads(cohort.id, moderator))[0].id).toBe(thread.id);
    expect((await service.listThreads(cohort.id, admin))[0].id).toBe(thread.id);
  });

  it('denies withdrawn members and tracks reply counts', async () => {
    const service = makeService();
    const cohort = await openCohort(service, 'youth');
    await service.enrol(cohort.id, { userId: member.id, declaredAge: 25 }, INSIDE_WINDOW);
    const thread = await service.createThread(cohort.id, 'Market day', member);
    await service.postToThread(thread.id, 'First post', moderator);
    expect((await service.listThreads(cohort.id, member))[0].replyCount).toBe(1);
    expect(await service.listThreadPosts(thread.id, member)).toHaveLength(1);
    await service.withdrawEnrolment(cohort.id, member.id, member);
    await expect(service.listThreadPosts(thread.id, member)).rejects.toThrowError(ForbiddenException);
  });
});
