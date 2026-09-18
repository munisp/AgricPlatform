import type pg from 'pg';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import { guardianLinkMapper } from '../pg/row-mappers.js';
import type {
  GuardianLink,
  GuardianLinkCriteria,
  GuardianLinkRepository
} from './guardian-link.repository.js';

export function guardianLinkCriteriaSql(criteria: GuardianLinkCriteria): WhereClause {
  return composeWhere(
    eq('dependent_user_id', criteria.dependentUserId),
    eq('guardian_user_id', criteria.guardianUserId),
    eq('custodian_agent_id', criteria.custodianAgentId),
    eq('contact_phone', criteria.contactPhone)
  );
}

/** V-44: identity.guardian_links (migration 087). */
export class PgGuardianLinkRepository
  extends PgRepositoryBase<GuardianLink, GuardianLinkCriteria>
  implements GuardianLinkRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'identity.guardian_links',
      mapper: guardianLinkMapper,
      criteria: guardianLinkCriteriaSql
    });
  }
}

export function createPgGuardianLinkRepository(pool: pg.Pool): PgGuardianLinkRepository {
  return new PgGuardianLinkRepository(pool);
}
