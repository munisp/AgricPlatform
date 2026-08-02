import type { PathwayStage, PathwayTemplate, PathwayTrack } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface PathwayTemplateCriteria {
  track?: PathwayTrack;
}

export type PathwayTemplateRepository = AsyncRepository<PathwayTemplate, PathwayTemplateCriteria>;

export function pathwayTemplateMatcher(
  criteria: PathwayTemplateCriteria
): (template: PathwayTemplate) => boolean {
  return (template) => !criteria.track || template.track === criteria.track;
}

export class InMemoryPathwayTemplateRepository
  extends InMemoryRepository<PathwayTemplate, PathwayTemplateCriteria>
  implements PathwayTemplateRepository
{
  constructor(seed: readonly PathwayTemplate[] = []) {
    super(seed, pathwayTemplateMatcher);
  }
}

export interface PathwayStageCriteria {
  templateId?: string;
}

export type PathwayStageRepository = AsyncRepository<PathwayStage, PathwayStageCriteria>;

export function pathwayStageMatcher(criteria: PathwayStageCriteria): (stage: PathwayStage) => boolean {
  return (stage) => !criteria.templateId || stage.templateId === criteria.templateId;
}

export class InMemoryPathwayStageRepository
  extends InMemoryRepository<PathwayStage, PathwayStageCriteria>
  implements PathwayStageRepository
{
  constructor(seed: readonly PathwayStage[] = []) {
    super(seed, pathwayStageMatcher);
  }
}

export function createInMemoryPathwayTemplateRepository(): InMemoryPathwayTemplateRepository {
  return new InMemoryPathwayTemplateRepository();
}

export function createInMemoryPathwayStageRepository(): InMemoryPathwayStageRepository {
  return new InMemoryPathwayStageRepository();
}
