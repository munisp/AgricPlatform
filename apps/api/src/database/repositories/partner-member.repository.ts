import type pg from 'pg';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { seedPartnerMembers, type PartnerMember } from '../seed-data.js';

/**
 * Partner tenant binding persistence (Stage 24, audit A2-1). The
 * PartnerMember shape and development seed live in ../seed-data.ts (the
 * DeletionRequest pattern). Table lives in the `partners` schema
 * (infra/postgres/051_partner_members.sql).
 */
export type { PartnerMember } from '../seed-data.js';

export interface PartnerMemberCriteria {
  userId?: string;
  partnerId?: string;
}

export type PartnerMemberRepository = AsyncRepository<PartnerMember, PartnerMemberCriteria>;

export function partnerMemberMatcher(
  criteria: PartnerMemberCriteria
): (item: PartnerMember) => boolean {
  return (item) =>
    (!criteria.userId || item.userId === criteria.userId) &&
    (!criteria.partnerId || item.partnerId === criteria.partnerId);
}

export class InMemoryPartnerMemberRepository
  extends InMemoryRepository<PartnerMember, PartnerMemberCriteria>
  implements PartnerMemberRepository
{
  constructor(seed: readonly PartnerMember[] = []) {
    super(seed, partnerMemberMatcher);
  }
}

export function createInMemoryPartnerMemberRepository(
  seed: readonly PartnerMember[] = seedPartnerMembers
): InMemoryPartnerMemberRepository {
  return new InMemoryPartnerMemberRepository(seed);
}

const partnerMemberMapper: RowMapper<PartnerMember> = {
  columns: ['id', 'user_id', 'partner_id', 'created_by', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    partnerId: row.partner_id as string,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string).toISOString()
  }),
  toRow: (item) => ({
    id: item.id,
    user_id: item.userId,
    partner_id: item.partnerId,
    created_by: item.createdBy,
    created_at: item.createdAt
  })
};

function partnerMemberCriteriaSql(criteria: PartnerMemberCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('partner_id', criteria.partnerId));
}

export class PgPartnerMemberRepository
  extends PgRepositoryBase<PartnerMember, PartnerMemberCriteria>
  implements PartnerMemberRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'partners.partner_members',
      mapper: partnerMemberMapper,
      criteria: partnerMemberCriteriaSql,
      orderBy: 'created_at, id'
    });
  }
}

export function createPgPartnerMemberRepository(pool: pg.Pool): PgPartnerMemberRepository {
  return new PgPartnerMemberRepository(pool);
}
