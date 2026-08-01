import type pg from 'pg';
import type { Opportunity, OpportunityApplication } from '@agric-platform/shared';
import {
  arrayContains,
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { applicationMapper, opportunityMapper } from '../pg/row-mappers.js';
import type { ApplicationCriteria, ApplicationRepository } from './application.repository.js';
import type { OpportunityCriteria, OpportunityRepository } from './opportunity.repository.js';

export function opportunityCriteriaSql(criteria: OpportunityCriteria): WhereClause {
  return composeWhere(
    eq('type', criteria.type),
    criteria.active === undefined ? null : eq('is_active', criteria.active),
    arrayContains('states', criteria.state),
    arrayContains('value_chains', criteria.valueChain)
  );
}

const OPPORTUNITY_COLUMNS = opportunityMapper.columns.join(', ');

export class PgOpportunityRepository
  extends PgRepositoryBase<Opportunity, OpportunityCriteria>
  implements OpportunityRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'opportunities.opportunities',
      mapper: opportunityMapper,
      criteria: opportunityCriteriaSql
    });
  }

  /**
   * Profile-match recommendation (plan §2.5.1): empty arrays match anything;
   * otherwise the profile state must be contained and at least one value
   * chain must overlap. Only active postings.
   */
  async findRecommendedForProfile(
    profileState: string | undefined,
    profileValueChains: string[]
  ): Promise<Opportunity[]> {
    const result = await this.pool.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities.opportunities
        WHERE is_active
          AND (cardinality(states) = 0 OR states @> ARRAY[$1]::text[])
          AND (cardinality(value_chains) = 0 OR value_chains && $2::text[])
        ORDER BY id`,
      [profileState ?? '', profileValueChains]
    );
    return result.rows.map((row) => opportunityMapper.fromRow(row));
  }

  async findByPartner(partnerId: string): Promise<Opportunity[]> {
    const result = await this.pool.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities.opportunities WHERE partner_id = $1 ORDER BY id`,
      [partnerId]
    );
    return result.rows.map((row) => opportunityMapper.fromRow(row));
  }
}

export function applicationCriteriaSql(criteria: ApplicationCriteria): WhereClause {
  return composeWhere(
    eq('user_id', criteria.userId),
    eq('opportunity_id', criteria.opportunityId),
    eq('status', criteria.status)
  );
}

const APPLICATION_COLUMNS = applicationMapper.columns.join(', ');

export class PgApplicationRepository
  extends PgRepositoryBase<OpportunityApplication, ApplicationCriteria>
  implements ApplicationRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'opportunities.applications',
      mapper: applicationMapper,
      criteria: applicationCriteriaSql
    });
  }

  /** Applications to any opportunity owned by the partner (JOIN). */
  async findForPartner(partnerId: string): Promise<OpportunityApplication[]> {
    const result = await this.pool.query(
      `SELECT ${APPLICATION_COLUMNS.split(', ')
        .map((column) => `a.${column.trim()}`)
        .join(', ')}
         FROM opportunities.applications a
         JOIN opportunities.opportunities o ON o.id = a.opportunity_id
        WHERE o.partner_id = $1
        ORDER BY a.id`,
      [partnerId]
    );
    return result.rows.map((row) => applicationMapper.fromRow(row));
  }

  /** The user's non-withdrawn application for an opportunity, if any. */
  async findActive(
    opportunityId: string,
    userId: string
  ): Promise<OpportunityApplication | undefined> {
    const result = await this.pool.query(
      `SELECT ${APPLICATION_COLUMNS} FROM opportunities.applications
        WHERE opportunity_id = $1 AND user_id = $2 AND status <> 'withdrawn'
        LIMIT 1`,
      [opportunityId, userId]
    );
    return result.rows[0] ? applicationMapper.fromRow(result.rows[0]) : undefined;
  }
}

export function createPgOpportunityRepository(pool: pg.Pool): PgOpportunityRepository {
  return new PgOpportunityRepository(pool);
}

export function createPgApplicationRepository(pool: pg.Pool): PgApplicationRepository {
  return new PgApplicationRepository(pool);
}
