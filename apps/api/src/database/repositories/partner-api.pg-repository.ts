import type pg from 'pg';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  ApiKeyCriteria,
  ApiKeyRepository,
  DeveloperApiKey,
  PartnerClient,
  PartnerClientCriteria,
  PartnerClientRepository,
  WebhookSubscription,
  WebhookSubscriptionCriteria,
  WebhookSubscriptionRepository
} from './partner-api.repository.js';

// Mappers live next to the repositories (matching the wave P1 pattern) to
// keep the wave P5d diff additive and conflict-free with concurrent waves.

const partnerClientMapper: RowMapper<PartnerClient> = {
  columns: [
    'id',
    'name',
    'client_id',
    'client_secret_hash',
    'client_secret_salt',
    'scopes',
    'status',
    'rate_limit_per_min',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    clientId: row.client_id as string,
    clientSecretHash: row.client_secret_hash as string,
    clientSecretSalt: row.client_secret_salt as string,
    scopes: (row.scopes as string[]) ?? [],
    status: row.status as PartnerClient['status'],
    rateLimitPerMin: Number(row.rate_limit_per_min),
    createdAt: new Date(row.created_at as string).toISOString()
  }),
  toRow: (item) => ({
    id: item.id,
    name: item.name,
    client_id: item.clientId,
    client_secret_hash: item.clientSecretHash,
    client_secret_salt: item.clientSecretSalt,
    scopes: item.scopes,
    status: item.status,
    rate_limit_per_min: item.rateLimitPerMin,
    created_at: item.createdAt
  })
};

const apiKeyMapper: RowMapper<DeveloperApiKey> = {
  columns: [
    'id',
    'owner_user_id',
    'key_hash',
    'key_salt',
    'prefix',
    'scopes',
    'sandbox',
    'revoked_at',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    keyHash: row.key_hash as string,
    keySalt: row.key_salt as string,
    prefix: row.prefix as string,
    scopes: (row.scopes as string[]) ?? [],
    sandbox: Boolean(row.sandbox),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : undefined,
    createdAt: new Date(row.created_at as string).toISOString()
  }),
  toRow: (item) => ({
    id: item.id,
    owner_user_id: item.ownerUserId,
    key_hash: item.keyHash,
    key_salt: item.keySalt,
    prefix: item.prefix,
    scopes: item.scopes,
    sandbox: item.sandbox,
    revoked_at: item.revokedAt ?? null,
    created_at: item.createdAt
  })
};

const webhookSubscriptionMapper: RowMapper<WebhookSubscription> = {
  columns: ['id', 'client_id', 'event_types', 'target_url', 'secret', 'status', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    clientId: row.client_id as string,
    eventTypes: (row.event_types as string[]) ?? [],
    targetUrl: row.target_url as string,
    secret: row.secret as string,
    status: row.status as WebhookSubscription['status'],
    createdAt: new Date(row.created_at as string).toISOString()
  }),
  toRow: (item) => ({
    id: item.id,
    client_id: item.clientId,
    event_types: item.eventTypes,
    target_url: item.targetUrl,
    secret: item.secret,
    status: item.status,
    created_at: item.createdAt
  })
};

function partnerClientCriteriaSql(criteria: PartnerClientCriteria): WhereClause {
  return composeWhere(eq('client_id', criteria.clientId), eq('status', criteria.status));
}

function apiKeyCriteriaSql(criteria: ApiKeyCriteria): WhereClause {
  return composeWhere(eq('owner_user_id', criteria.ownerUserId), eq('prefix', criteria.prefix));
}

function webhookSubscriptionCriteriaSql(criteria: WebhookSubscriptionCriteria): WhereClause {
  return composeWhere(eq('client_id', criteria.clientId), eq('status', criteria.status));
}

export class PgPartnerClientRepository
  extends PgRepositoryBase<PartnerClient, PartnerClientCriteria>
  implements PartnerClientRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'partners.partner_clients',
      mapper: partnerClientMapper,
      criteria: partnerClientCriteriaSql,
      orderBy: 'created_at, id'
    });
  }
}

export class PgApiKeyRepository
  extends PgRepositoryBase<DeveloperApiKey, ApiKeyCriteria>
  implements ApiKeyRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'partners.api_keys',
      mapper: apiKeyMapper,
      criteria: apiKeyCriteriaSql,
      orderBy: 'created_at, id'
    });
  }
}

export class PgWebhookSubscriptionRepository
  extends PgRepositoryBase<WebhookSubscription, WebhookSubscriptionCriteria>
  implements WebhookSubscriptionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'partners.webhook_subscriptions',
      mapper: webhookSubscriptionMapper,
      criteria: webhookSubscriptionCriteriaSql,
      orderBy: 'created_at, id'
    });
  }
}

export function createPgPartnerClientRepository(pool: pg.Pool): PgPartnerClientRepository {
  return new PgPartnerClientRepository(pool);
}

export function createPgApiKeyRepository(pool: pg.Pool): PgApiKeyRepository {
  return new PgApiKeyRepository(pool);
}

export function createPgWebhookSubscriptionRepository(
  pool: pg.Pool
): PgWebhookSubscriptionRepository {
  return new PgWebhookSubscriptionRepository(pool);
}
