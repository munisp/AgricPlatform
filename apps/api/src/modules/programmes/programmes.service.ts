import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  ApiListResponse,
  CohortStatus,
  CohortThread,
  CohortThreadPost,
  JudgeAssignment,
  JudgeScore,
  LeaderboardEntry,
  MilestoneProgress,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeMilestone,
  ProgrammeType,
  RubricCriterion,
  User
} from '@agric-platform/shared';
import { YOUTH_MAX_AGE, YOUTH_MIN_AGE } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  COHORT_THREAD_POST_REPOSITORY,
  COHORT_THREAD_REPOSITORY,
  JUDGE_ASSIGNMENT_REPOSITORY,
  JUDGE_SCORE_REPOSITORY,
  MILESTONE_PROGRESS_REPOSITORY,
  PROGRAMME_COHORT_REPOSITORY,
  PROGRAMME_ENROLMENT_REPOSITORY,
  PROGRAMME_MILESTONE_REPOSITORY,
  RUBRIC_CRITERION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CohortThreadPostRepository,
  CohortThreadRepository
} from '../../database/repositories/cohort-thread.repository.js';
import type {
  JudgeAssignmentRepository,
  JudgeScoreRepository,
  RubricCriterionRepository
} from '../../database/repositories/judging.repository.js';
import type { ProgrammeCohortRepository } from '../../database/repositories/programme-cohort.repository.js';
import type { ProgrammeEnrolmentRepository } from '../../database/repositories/programme-enrolment.repository.js';
import type {
  MilestoneProgressRepository,
  ProgrammeMilestoneRepository
} from '../../database/repositories/programme-milestone.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';

export interface CreateCohortInput {
  name: string;
  programmeType: ProgrammeType;
  capacity: number;
  enrolmentOpensAt: string;
  enrolmentClosesAt: string;
  moderatorIds?: string[];
}

export interface EnrolInput {
  userId: string;
  declaredAge?: number;
  declaredGender?: ProgrammeEnrolment['declaredGender'];
}

type Actor = Pick<User, 'id' | 'roles'>;

/** Cohort lifecycle: draft → open → closed → active → completed. */
const COHORT_TRANSITIONS: Readonly<Record<CohortStatus, readonly CohortStatus[]>> = {
  draft: ['open'],
  open: ['closed'],
  closed: ['active'],
  active: ['completed'],
  completed: []
};

@Injectable()
export class ProgrammesService {
  constructor(
    private readonly domainEvents: DomainEventsService,
    @Inject(PROGRAMME_COHORT_REPOSITORY) private readonly cohorts: ProgrammeCohortRepository,
    @Inject(PROGRAMME_ENROLMENT_REPOSITORY) private readonly enrolments: ProgrammeEnrolmentRepository,
    @Inject(PROGRAMME_MILESTONE_REPOSITORY) private readonly milestones: ProgrammeMilestoneRepository,
    @Inject(MILESTONE_PROGRESS_REPOSITORY) private readonly progress: MilestoneProgressRepository,
    @Inject(RUBRIC_CRITERION_REPOSITORY) private readonly criteria: RubricCriterionRepository,
    @Inject(JUDGE_ASSIGNMENT_REPOSITORY) private readonly judgeAssignments: JudgeAssignmentRepository,
    @Inject(JUDGE_SCORE_REPOSITORY) private readonly scores: JudgeScoreRepository,
    @Inject(COHORT_THREAD_REPOSITORY) private readonly threads: CohortThreadRepository,
    @Inject(COHORT_THREAD_POST_REPOSITORY) private readonly threadPosts: CohortThreadPostRepository
  ) {}

  // -- Cohorts -------------------------------------------------------------------

  async listCohorts(filter: {
    programmeType?: ProgrammeType;
    status?: CohortStatus;
    page?: number;
    pageSize?: number;
  }): Promise<ApiListResponse<ProgrammeCohort>> {
    return this.cohorts.searchPage(
      { programmeType: filter.programmeType, status: filter.status },
      filter.page,
      filter.pageSize
    );
  }

  async getCohort(id: string): Promise<ProgrammeCohort> {
    return this.cohorts.getById(id);
  }

  async createCohort(input: CreateCohortInput, actorId: string): Promise<ProgrammeCohort> {
    if (input.enrolmentClosesAt <= input.enrolmentOpensAt) {
      throw new BadRequestException('enrolmentClosesAt must be after enrolmentOpensAt');
    }
    const cohort: ProgrammeCohort = {
      id: newId('cohort'),
      name: input.name,
      programmeType: input.programmeType,
      capacity: input.capacity,
      enrolmentOpensAt: input.enrolmentOpensAt,
      enrolmentClosesAt: input.enrolmentClosesAt,
      status: 'draft',
      moderatorIds: input.moderatorIds ?? [],
      createdAt: new Date().toISOString()
    };
    const created = await this.cohorts.create(cohort);
    await this.domainEvents.publish('programmes.cohort.created', { cohortId: created.id }, actorId);
    return created;
  }

  async setCohortStatus(id: string, status: CohortStatus, actorId: string): Promise<ProgrammeCohort> {
    const cohort = await this.cohorts.getById(id);
    if (status === cohort.status) {
      return cohort;
    }
    if (!COHORT_TRANSITIONS[cohort.status].includes(status)) {
      throw new BadRequestException(
        `Invalid cohort transition from '${cohort.status}' to '${status}'`
      );
    }
    const updated = await this.cohorts.update(id, { status });
    await this.domainEvents.publish('programmes.cohort.status_changed', { cohortId: id, status }, actorId);
    return updated;
  }

  // -- Enrolments -----------------------------------------------------------------

  async enrol(cohortId: string, input: EnrolInput, now: Date = new Date()): Promise<ProgrammeEnrolment> {
    const cohort = await this.cohorts.getById(cohortId);
    if (cohort.status !== 'open') {
      throw new ConflictException('Cohort is not open for enrolment');
    }
    const nowIso = now.toISOString();
    if (nowIso < cohort.enrolmentOpensAt || nowIso > cohort.enrolmentClosesAt) {
      throw new ConflictException('Enrolment window is not active');
    }
    this.assertEligibility(cohort, input);
    if (await this.enrolments.findOne({ cohortId, userId: input.userId, status: 'enrolled' })) {
      throw new ConflictException('User is already enrolled in this cohort');
    }
    const activeCount = await this.enrolments.count({ cohortId, status: 'enrolled' });
    if (activeCount >= cohort.capacity) {
      throw new ConflictException('Cohort is at full capacity');
    }
    const enrolment: ProgrammeEnrolment = {
      id: newId('enrolment'),
      cohortId,
      userId: input.userId,
      declaredAge: input.declaredAge,
      declaredGender: input.declaredGender,
      status: 'enrolled',
      enrolledAt: nowIso
    };
    const created = await this.enrolments.create(enrolment);
    await this.domainEvents.publish(
      'programmes.enrolment.recorded',
      { enrolmentId: created.id, cohortId },
      input.userId
    );
    return created;
  }

  /** Declared-attribute eligibility: women cohorts gate on gender, youth cohorts on the age band. */
  private assertEligibility(cohort: ProgrammeCohort, input: EnrolInput): void {
    if (cohort.programmeType === 'women' && input.declaredGender !== 'female') {
      throw new ForbiddenException('This programme requires a declared female gender');
    }
    if (cohort.programmeType === 'youth') {
      if (input.declaredAge === undefined) {
        throw new ForbiddenException('This programme requires a declared age');
      }
      if (input.declaredAge < YOUTH_MIN_AGE || input.declaredAge > YOUTH_MAX_AGE) {
        throw new ForbiddenException(
          `This programme is restricted to ages ${YOUTH_MIN_AGE}–${YOUTH_MAX_AGE}`
        );
      }
    }
  }

  async listEnrolments(cohortId: string): Promise<ProgrammeEnrolment[]> {
    await this.cohorts.getById(cohortId);
    return this.enrolments.find({ cohortId });
  }

  async withdrawEnrolment(cohortId: string, userId: string, actor: Actor): Promise<ProgrammeEnrolment> {
    if (actor.id !== userId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Members may only withdraw their own enrolment');
    }
    const enrolment = await this.enrolments.findOne({ cohortId, userId, status: 'enrolled' });
    if (!enrolment) {
      throw new ConflictException('No active enrolment for this user in the cohort');
    }
    const updated = await this.enrolments.update(enrolment.id, { status: 'withdrawn' });
    await this.domainEvents.publish('programmes.enrolment.withdrawn', { enrolmentId: enrolment.id, cohortId }, actor.id);
    return updated;
  }

  // -- Milestones & progress ---------------------------------------------------------

  async addMilestone(
    cohortId: string,
    input: { title: string; sequence: number; dueAt?: string },
    actorId: string
  ): Promise<ProgrammeMilestone> {
    await this.cohorts.getById(cohortId);
    const milestone: ProgrammeMilestone = {
      id: newId('milestone'),
      cohortId,
      title: input.title,
      sequence: input.sequence,
      dueAt: input.dueAt
    };
    const created = await this.milestones.create(milestone);
    await this.domainEvents.publish('programmes.milestone.created', { milestoneId: created.id, cohortId }, actorId);
    return created;
  }

  async listMilestones(cohortId: string): Promise<ProgrammeMilestone[]> {
    await this.cohorts.getById(cohortId);
    const milestones = await this.milestones.find({ cohortId });
    return milestones.sort((a, b) => a.sequence - b.sequence);
  }

  async setMilestoneProgress(
    milestoneId: string,
    userId: string,
    status: MilestoneProgress['status'],
    actor: Actor
  ): Promise<MilestoneProgress> {
    await this.milestones.getById(milestoneId);
    if (actor.id !== userId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Members may only update their own progress');
    }
    const existing = await this.progress.findOne({ milestoneId, userId });
    const record: MilestoneProgress = {
      id: existing?.id ?? newId('progress'),
      milestoneId,
      userId,
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : undefined
    };
    if (existing) {
      return this.progress.update(existing.id, record);
    }
    return this.progress.create(record);
  }

  async progressForUser(cohortId: string, userId: string): Promise<MilestoneProgress[]> {
    const milestones = await this.milestones.find({ cohortId });
    const milestoneIds = new Set(milestones.map((m) => m.id));
    return (await this.progress.find({ userId })).filter((p) => milestoneIds.has(p.milestoneId));
  }

  // -- Judging ------------------------------------------------------------------------

  async addRubricCriterion(
    cohortId: string,
    input: { name: string; maxScore: number },
    actorId: string
  ): Promise<RubricCriterion> {
    await this.cohorts.getById(cohortId);
    if (!Number.isInteger(input.maxScore) || input.maxScore <= 0) {
      throw new BadRequestException('maxScore must be a positive integer');
    }
    const criterion: RubricCriterion = {
      id: newId('criterion'),
      cohortId,
      name: input.name,
      maxScore: input.maxScore
    };
    const created = await this.criteria.create(criterion);
    await this.domainEvents.publish('programmes.criterion.created', { criterionId: created.id, cohortId }, actorId);
    return created;
  }

  async assignJudge(cohortId: string, judgeUserId: string, actorId: string): Promise<JudgeAssignment> {
    await this.cohorts.getById(cohortId);
    if (await this.judgeAssignments.findOne({ cohortId, judgeUserId })) {
      throw new ConflictException('User is already a judge for this cohort');
    }
    const assignment: JudgeAssignment = {
      id: newId('judge'),
      cohortId,
      judgeUserId,
      assignedAt: new Date().toISOString()
    };
    const created = await this.judgeAssignments.create(assignment);
    await this.domainEvents.publish('programmes.judge.assigned', { cohortId, judgeUserId }, actorId);
    return created;
  }

  /** Score submission is unique per judge + entry + criterion. */
  async submitScore(
    cohortId: string,
    judgeUserId: string,
    entryUserId: string,
    criterionId: string,
    score: number
  ): Promise<JudgeScore> {
    await this.cohorts.getById(cohortId);
    if (!(await this.judgeAssignments.findOne({ cohortId, judgeUserId }))) {
      throw new ForbiddenException('Only assigned judges may submit scores');
    }
    if (!(await this.enrolments.findOne({ cohortId, userId: entryUserId, status: 'enrolled' }))) {
      throw new BadRequestException('Scores may only be submitted for enrolled members');
    }
    const criterion = await this.criteria.getById(criterionId);
    if (criterion.cohortId !== cohortId) {
      throw new BadRequestException('Criterion does not belong to this cohort');
    }
    if (!Number.isInteger(score) || score < 0 || score > criterion.maxScore) {
      throw new BadRequestException(`Score must be an integer between 0 and ${criterion.maxScore}`);
    }
    if (await this.scores.findOne({ judgeUserId, entryUserId, criterionId })) {
      throw new ConflictException('Judge has already scored this entry for this criterion');
    }
    const record: JudgeScore = {
      id: newId('score'),
      cohortId,
      judgeUserId,
      entryUserId,
      criterionId,
      score,
      submittedAt: new Date().toISOString()
    };
    const created = await this.scores.create(record);
    await this.domainEvents.publish(
      'programmes.score.submitted',
      { scoreId: created.id, cohortId, entryUserId },
      judgeUserId
    );
    return created;
  }

  /** Leaderboard: total across criteria per entry, ties broken by user id. */
  async leaderboard(cohortId: string): Promise<LeaderboardEntry[]> {
    await this.cohorts.getById(cohortId);
    const cohortScores = await this.scores.find({ cohortId });
    const byEntry = new Map<string, { total: number; judges: Set<string> }>();
    for (const score of cohortScores) {
      const bucket = byEntry.get(score.entryUserId) ?? { total: 0, judges: new Set<string>() };
      bucket.total += score.score;
      bucket.judges.add(score.judgeUserId);
      byEntry.set(score.entryUserId, bucket);
    }
    const entries = [...byEntry.entries()]
      .map(([entryUserId, bucket]) => ({
        entryUserId,
        totalScore: bucket.total,
        judgeCount: bucket.judges.size,
        averageScore:
          bucket.judges.size === 0 ? 0 : Math.round((bucket.total / bucket.judges.size) * 100) / 100,
        rank: 0
      }))
      .sort((a, b) => b.totalScore - a.totalScore || a.entryUserId.localeCompare(b.entryUserId));
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    return entries;
  }

  // -- Protected spaces (cohort-scoped threads) ---------------------------------------

  /** Visible to enrolled members, cohort moderators and admins only. */
  private async assertSpaceAccess(cohortId: string, actor: Actor): Promise<ProgrammeCohort> {
    const cohort = await this.cohorts.getById(cohortId);
    if (actor.roles.includes('admin') || cohort.moderatorIds.includes(actor.id)) {
      return cohort;
    }
    const enrolment = await this.enrolments.findOne({ cohortId, userId: actor.id });
    if (!enrolment || enrolment.status === 'withdrawn') {
      throw new ForbiddenException('Protected space: only enrolled members and moderators may access');
    }
    return cohort;
  }

  async listThreads(cohortId: string, actor: Actor): Promise<CohortThread[]> {
    await this.assertSpaceAccess(cohortId, actor);
    return this.threads.find({ cohortId });
  }

  async createThread(cohortId: string, title: string, actor: Actor): Promise<CohortThread> {
    await this.assertSpaceAccess(cohortId, actor);
    const thread: CohortThread = {
      id: newId('thread'),
      cohortId,
      title,
      authorId: actor.id,
      replyCount: 0,
      createdAt: new Date().toISOString()
    };
    const created = await this.threads.create(thread);
    await this.domainEvents.publish('programmes.thread.created', { threadId: created.id, cohortId }, actor.id);
    return created;
  }

  async listThreadPosts(threadId: string, actor: Actor): Promise<CohortThreadPost[]> {
    const thread = await this.threads.getById(threadId);
    await this.assertSpaceAccess(thread.cohortId, actor);
    return this.threadPosts.find({ threadId });
  }

  async postToThread(threadId: string, body: string, actor: Actor): Promise<CohortThreadPost> {
    const thread = await this.threads.getById(threadId);
    await this.assertSpaceAccess(thread.cohortId, actor);
    const post: CohortThreadPost = {
      id: newId('post'),
      threadId,
      authorId: actor.id,
      body,
      createdAt: new Date().toISOString()
    };
    const created = await this.threadPosts.create(post);
    await this.threads.incrementReplyCount(threadId);
    await this.domainEvents.publish('programmes.thread.replied', { threadId, postId: created.id }, actor.id);
    return created;
  }
}
