import type { JudgeAssignment, JudgeScore, RubricCriterion } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface RubricCriterionCriteria {
  cohortId?: string;
}

export type RubricCriterionRepository = AsyncRepository<RubricCriterion, RubricCriterionCriteria>;

export function rubricCriterionMatcher(
  criteria: RubricCriterionCriteria
): (criterion: RubricCriterion) => boolean {
  return (criterion) => !criteria.cohortId || criterion.cohortId === criteria.cohortId;
}

export class InMemoryRubricCriterionRepository
  extends InMemoryRepository<RubricCriterion, RubricCriterionCriteria>
  implements RubricCriterionRepository
{
  constructor(seed: readonly RubricCriterion[] = []) {
    super(seed, rubricCriterionMatcher);
  }
}

export interface JudgeAssignmentCriteria {
  cohortId?: string;
  judgeUserId?: string;
}

export type JudgeAssignmentRepository = AsyncRepository<JudgeAssignment, JudgeAssignmentCriteria>;

export function judgeAssignmentMatcher(
  criteria: JudgeAssignmentCriteria
): (assignment: JudgeAssignment) => boolean {
  return (assignment) =>
    (!criteria.cohortId || assignment.cohortId === criteria.cohortId) &&
    (!criteria.judgeUserId || assignment.judgeUserId === criteria.judgeUserId);
}

export class InMemoryJudgeAssignmentRepository
  extends InMemoryRepository<JudgeAssignment, JudgeAssignmentCriteria>
  implements JudgeAssignmentRepository
{
  constructor(seed: readonly JudgeAssignment[] = []) {
    super(seed, judgeAssignmentMatcher);
  }
}

export interface JudgeScoreCriteria {
  cohortId?: string;
  judgeUserId?: string;
  entryUserId?: string;
  criterionId?: string;
}

export type JudgeScoreRepository = AsyncRepository<JudgeScore, JudgeScoreCriteria>;

export function judgeScoreMatcher(criteria: JudgeScoreCriteria): (score: JudgeScore) => boolean {
  return (score) =>
    (!criteria.cohortId || score.cohortId === criteria.cohortId) &&
    (!criteria.judgeUserId || score.judgeUserId === criteria.judgeUserId) &&
    (!criteria.entryUserId || score.entryUserId === criteria.entryUserId) &&
    (!criteria.criterionId || score.criterionId === criteria.criterionId);
}

export class InMemoryJudgeScoreRepository
  extends InMemoryRepository<JudgeScore, JudgeScoreCriteria>
  implements JudgeScoreRepository
{
  constructor(seed: readonly JudgeScore[] = []) {
    super(seed, judgeScoreMatcher);
  }
}

export function createInMemoryRubricCriterionRepository(): InMemoryRubricCriterionRepository {
  return new InMemoryRubricCriterionRepository();
}

export function createInMemoryJudgeAssignmentRepository(): InMemoryJudgeAssignmentRepository {
  return new InMemoryJudgeAssignmentRepository();
}

export function createInMemoryJudgeScoreRepository(): InMemoryJudgeScoreRepository {
  return new InMemoryJudgeScoreRepository();
}
