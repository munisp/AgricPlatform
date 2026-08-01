import type { ApiListResponse, Course, LanguageCode } from '@agric-platform/shared';
import { seedCourses } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { ilike, InMemoryRepository } from '../../common/in-memory.repository.js';

export interface CourseCriteria {
  category?: string;
  level?: Course['level'];
  language?: LanguageCode;
  q?: string;
}

export interface CourseRepository extends AsyncRepository<Course, CourseCriteria> {
  searchPage(
    criteria: CourseCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<Course>>;
}

export function courseMatcher(criteria: CourseCriteria): (course: Course) => boolean {
  return (course) =>
    (!criteria.category || course.category === criteria.category) &&
    (!criteria.level || course.level === criteria.level) &&
    (!criteria.language || course.language === criteria.language) &&
    (!criteria.q || ilike(course.title, criteria.q));
}

export class InMemoryCourseRepository
  extends InMemoryRepository<Course, CourseCriteria>
  implements CourseRepository
{
  constructor(seed: readonly Course[] = []) {
    super(seed, courseMatcher);
  }
}

export function createInMemoryCourseRepository(): InMemoryCourseRepository {
  return new InMemoryCourseRepository(seedCourses);
}
