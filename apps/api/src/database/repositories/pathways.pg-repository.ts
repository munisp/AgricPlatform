import type pg from 'pg';
import type {
  CampusClub,
  CampusClubMembership,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  StageProgress
} from '@agric-platform/shared';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import {
  campusClubMapper,
  campusClubMembershipMapper,
  pathwayEnrolmentMapper,
  pathwayStageMapper,
  pathwayTemplateMapper,
  stageProgressMapper
} from '../pg/row-mappers.js';
import type {
  CampusClubCriteria,
  CampusClubMembershipCriteria,
  CampusClubMembershipRepository,
  CampusClubRepository
} from './campus-club.repository.js';
import type {
  PathwayEnrolmentCriteria,
  PathwayEnrolmentRepository,
  StageProgressCriteria,
  StageProgressRepository
} from './pathway-enrolment.repository.js';
import type {
  PathwayStageCriteria,
  PathwayStageRepository,
  PathwayTemplateCriteria,
  PathwayTemplateRepository
} from './pathway.repository.js';

export function pathwayTemplateCriteriaSql(criteria: PathwayTemplateCriteria): WhereClause {
  return composeWhere(eq('track', criteria.track));
}

export class PgPathwayTemplateRepository
  extends PgRepositoryBase<PathwayTemplate, PathwayTemplateCriteria>
  implements PathwayTemplateRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'pathways.templates',
      mapper: pathwayTemplateMapper,
      criteria: pathwayTemplateCriteriaSql
    });
  }
}

export function pathwayStageCriteriaSql(criteria: PathwayStageCriteria): WhereClause {
  return composeWhere(eq('template_id', criteria.templateId));
}

export class PgPathwayStageRepository
  extends PgRepositoryBase<PathwayStage, PathwayStageCriteria>
  implements PathwayStageRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'pathways.stages',
      mapper: pathwayStageMapper,
      criteria: pathwayStageCriteriaSql,
      orderBy: 'sequence'
    });
  }
}

export function pathwayEnrolmentCriteriaSql(criteria: PathwayEnrolmentCriteria): WhereClause {
  return composeWhere(
    eq('template_id', criteria.templateId),
    eq('user_id', criteria.userId),
    eq('status', criteria.status)
  );
}

export class PgPathwayEnrolmentRepository
  extends PgRepositoryBase<PathwayEnrolment, PathwayEnrolmentCriteria>
  implements PathwayEnrolmentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'pathways.enrolments',
      mapper: pathwayEnrolmentMapper,
      criteria: pathwayEnrolmentCriteriaSql
    });
  }
}

export function stageProgressCriteriaSql(criteria: StageProgressCriteria): WhereClause {
  return composeWhere(eq('enrolment_id', criteria.enrolmentId), eq('stage_id', criteria.stageId));
}

export class PgStageProgressRepository
  extends PgRepositoryBase<StageProgress, StageProgressCriteria>
  implements StageProgressRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'pathways.stage_progress',
      mapper: stageProgressMapper,
      criteria: stageProgressCriteriaSql
    });
  }
}

export function campusClubCriteriaSql(criteria: CampusClubCriteria): WhereClause {
  return composeWhere(
    eq('state', criteria.state),
    eq('institution', criteria.institution),
    eq('is_nysc_cds_group', criteria.isNyscCdsGroup)
  );
}

export class PgCampusClubRepository
  extends PgRepositoryBase<CampusClub, CampusClubCriteria>
  implements CampusClubRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'pathways.campus_clubs',
      mapper: campusClubMapper,
      criteria: campusClubCriteriaSql
    });
  }
}

export function campusClubMembershipCriteriaSql(criteria: CampusClubMembershipCriteria): WhereClause {
  return composeWhere(eq('club_id', criteria.clubId), eq('user_id', criteria.userId));
}

export class PgCampusClubMembershipRepository
  extends PgRepositoryBase<CampusClubMembership, CampusClubMembershipCriteria>
  implements CampusClubMembershipRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'pathways.campus_club_memberships',
      mapper: campusClubMembershipMapper,
      criteria: campusClubMembershipCriteriaSql
    });
  }
}

export function createPgPathwayTemplateRepository(pool: pg.Pool): PgPathwayTemplateRepository {
  return new PgPathwayTemplateRepository(pool);
}

export function createPgPathwayStageRepository(pool: pg.Pool): PgPathwayStageRepository {
  return new PgPathwayStageRepository(pool);
}

export function createPgPathwayEnrolmentRepository(pool: pg.Pool): PgPathwayEnrolmentRepository {
  return new PgPathwayEnrolmentRepository(pool);
}

export function createPgStageProgressRepository(pool: pg.Pool): PgStageProgressRepository {
  return new PgStageProgressRepository(pool);
}

export function createPgCampusClubRepository(pool: pg.Pool): PgCampusClubRepository {
  return new PgCampusClubRepository(pool);
}

export function createPgCampusClubMembershipRepository(pool: pg.Pool): PgCampusClubMembershipRepository {
  return new PgCampusClubMembershipRepository(pool);
}
