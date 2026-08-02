import type pg from 'pg';
import type {
  CohortThread,
  CohortThreadPost,
  JudgeAssignment,
  JudgeScore,
  MilestoneProgress,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeMilestone,
  RubricCriterion
} from '@agric-platform/shared';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import {
  cohortThreadMapper,
  cohortThreadPostMapper,
  judgeAssignmentMapper,
  judgeScoreMapper,
  milestoneProgressMapper,
  programmeCohortMapper,
  programmeEnrolmentMapper,
  programmeMilestoneMapper,
  rubricCriterionMapper
} from '../pg/row-mappers.js';
import type { CohortThreadCriteria, CohortThreadPostCriteria, CohortThreadPostRepository, CohortThreadRepository } from './cohort-thread.repository.js';
import type {
  JudgeAssignmentCriteria,
  JudgeAssignmentRepository,
  JudgeScoreCriteria,
  JudgeScoreRepository,
  RubricCriterionCriteria,
  RubricCriterionRepository
} from './judging.repository.js';
import type { ProgrammeCohortCriteria, ProgrammeCohortRepository } from './programme-cohort.repository.js';
import type { ProgrammeEnrolmentCriteria, ProgrammeEnrolmentRepository } from './programme-enrolment.repository.js';
import type {
  MilestoneProgressCriteria,
  MilestoneProgressRepository,
  ProgrammeMilestoneCriteria,
  ProgrammeMilestoneRepository
} from './programme-milestone.repository.js';

export function programmeCohortCriteriaSql(criteria: ProgrammeCohortCriteria): WhereClause {
  return composeWhere(eq('programme_type', criteria.programmeType), eq('status', criteria.status));
}

export class PgProgrammeCohortRepository
  extends PgRepositoryBase<ProgrammeCohort, ProgrammeCohortCriteria>
  implements ProgrammeCohortRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.cohorts',
      mapper: programmeCohortMapper,
      criteria: programmeCohortCriteriaSql
    });
  }
}

export function programmeEnrolmentCriteriaSql(criteria: ProgrammeEnrolmentCriteria): WhereClause {
  return composeWhere(
    eq('cohort_id', criteria.cohortId),
    eq('user_id', criteria.userId),
    eq('status', criteria.status)
  );
}

export class PgProgrammeEnrolmentRepository
  extends PgRepositoryBase<ProgrammeEnrolment, ProgrammeEnrolmentCriteria>
  implements ProgrammeEnrolmentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.enrolments',
      mapper: programmeEnrolmentMapper,
      criteria: programmeEnrolmentCriteriaSql
    });
  }
}

export function programmeMilestoneCriteriaSql(criteria: ProgrammeMilestoneCriteria): WhereClause {
  return composeWhere(eq('cohort_id', criteria.cohortId));
}

export class PgProgrammeMilestoneRepository
  extends PgRepositoryBase<ProgrammeMilestone, ProgrammeMilestoneCriteria>
  implements ProgrammeMilestoneRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.milestones',
      mapper: programmeMilestoneMapper,
      criteria: programmeMilestoneCriteriaSql,
      orderBy: 'sequence'
    });
  }
}

export function milestoneProgressCriteriaSql(criteria: MilestoneProgressCriteria): WhereClause {
  return composeWhere(
    eq('milestone_id', criteria.milestoneId),
    eq('user_id', criteria.userId),
    eq('status', criteria.status)
  );
}

export class PgMilestoneProgressRepository
  extends PgRepositoryBase<MilestoneProgress, MilestoneProgressCriteria>
  implements MilestoneProgressRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.milestone_progress',
      mapper: milestoneProgressMapper,
      criteria: milestoneProgressCriteriaSql
    });
  }
}

export function rubricCriterionCriteriaSql(criteria: RubricCriterionCriteria): WhereClause {
  return composeWhere(eq('cohort_id', criteria.cohortId));
}

export class PgRubricCriterionRepository
  extends PgRepositoryBase<RubricCriterion, RubricCriterionCriteria>
  implements RubricCriterionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.rubric_criteria',
      mapper: rubricCriterionMapper,
      criteria: rubricCriterionCriteriaSql
    });
  }
}

export function judgeAssignmentCriteriaSql(criteria: JudgeAssignmentCriteria): WhereClause {
  return composeWhere(eq('cohort_id', criteria.cohortId), eq('judge_user_id', criteria.judgeUserId));
}

export class PgJudgeAssignmentRepository
  extends PgRepositoryBase<JudgeAssignment, JudgeAssignmentCriteria>
  implements JudgeAssignmentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.judge_assignments',
      mapper: judgeAssignmentMapper,
      criteria: judgeAssignmentCriteriaSql
    });
  }
}

export function judgeScoreCriteriaSql(criteria: JudgeScoreCriteria): WhereClause {
  return composeWhere(
    eq('cohort_id', criteria.cohortId),
    eq('judge_user_id', criteria.judgeUserId),
    eq('entry_user_id', criteria.entryUserId),
    eq('criterion_id', criteria.criterionId)
  );
}

export class PgJudgeScoreRepository
  extends PgRepositoryBase<JudgeScore, JudgeScoreCriteria>
  implements JudgeScoreRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.judge_scores',
      mapper: judgeScoreMapper,
      criteria: judgeScoreCriteriaSql
    });
  }
}

export function cohortThreadCriteriaSql(criteria: CohortThreadCriteria): WhereClause {
  return composeWhere(eq('cohort_id', criteria.cohortId));
}

const THREAD_COLUMNS = cohortThreadMapper.columns.join(', ');

export class PgCohortThreadRepository
  extends PgRepositoryBase<CohortThread, CohortThreadCriteria>
  implements CohortThreadRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.cohort_threads',
      mapper: cohortThreadMapper,
      criteria: cohortThreadCriteriaSql
    });
  }

  async incrementReplyCount(id: string): Promise<CohortThread> {
    const result = await this.pool.query(
      `UPDATE programmes.cohort_threads SET reply_count = reply_count + 1
        WHERE id = $1 RETURNING ${THREAD_COLUMNS}`,
      [id]
    );
    if (!result.rows[0]) {
      return this.getById(id); // raises NotFoundException
    }
    return cohortThreadMapper.fromRow(result.rows[0]);
  }
}

export function cohortThreadPostCriteriaSql(criteria: CohortThreadPostCriteria): WhereClause {
  return composeWhere(eq('thread_id', criteria.threadId), eq('author_id', criteria.authorId));
}

export class PgCohortThreadPostRepository
  extends PgRepositoryBase<CohortThreadPost, CohortThreadPostCriteria>
  implements CohortThreadPostRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'programmes.cohort_thread_posts',
      mapper: cohortThreadPostMapper,
      criteria: cohortThreadPostCriteriaSql
    });
  }
}

export function createPgProgrammeCohortRepository(pool: pg.Pool): PgProgrammeCohortRepository {
  return new PgProgrammeCohortRepository(pool);
}

export function createPgProgrammeEnrolmentRepository(pool: pg.Pool): PgProgrammeEnrolmentRepository {
  return new PgProgrammeEnrolmentRepository(pool);
}

export function createPgProgrammeMilestoneRepository(pool: pg.Pool): PgProgrammeMilestoneRepository {
  return new PgProgrammeMilestoneRepository(pool);
}

export function createPgMilestoneProgressRepository(pool: pg.Pool): PgMilestoneProgressRepository {
  return new PgMilestoneProgressRepository(pool);
}

export function createPgRubricCriterionRepository(pool: pg.Pool): PgRubricCriterionRepository {
  return new PgRubricCriterionRepository(pool);
}

export function createPgJudgeAssignmentRepository(pool: pg.Pool): PgJudgeAssignmentRepository {
  return new PgJudgeAssignmentRepository(pool);
}

export function createPgJudgeScoreRepository(pool: pg.Pool): PgJudgeScoreRepository {
  return new PgJudgeScoreRepository(pool);
}

export function createPgCohortThreadRepository(pool: pg.Pool): PgCohortThreadRepository {
  return new PgCohortThreadRepository(pool);
}

export function createPgCohortThreadPostRepository(pool: pg.Pool): PgCohortThreadPostRepository {
  return new PgCohortThreadPostRepository(pool);
}
