import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Partner API persistence (wave P5d). Tables live in the `partners` schema
 * (infra/postgres/010_partner_api.sql). Secret material is only ever stored
 * hashed (sha256 + per-row salt); plaintext is shown once at issuance.
 */

export type PartnerClientStatus = 'active' | 'suspended';

export interface PartnerClient {
  id: string;
  name: string;
  clientId: string;
  clientSecretHash: string;
  clientSecretSalt: string;
  scopes: string[];
  status: PartnerClientStatus;
  /** Per-client rate bucket size (requests per minute, default 1000). */
  rateLimitPerMin: number;
  createdAt: string;
}

export interface PartnerClientCriteria {
  clientId?: string;
  status?: PartnerClientStatus;
}

export interface DeveloperApiKey {
  id: string;
  ownerUserId: string;
  keyHash: string;
  keySalt: string;
  /** First characters of the key, kept for support lookups (not secret). */
  prefix: string;
  scopes: string[];
  sandbox: boolean;
  revokedAt?: string;
  createdAt: string;
}

export interface ApiKeyCriteria {
  ownerUserId?: string;
  prefix?: string;
}

export type WebhookSubscriptionStatus = 'active' | 'disabled';

export interface WebhookSubscription {
  id: string;
  clientId: string;
  eventTypes: string[];
  targetUrl: string;
  /** HMAC delivery secret (used to sign outbound payloads). */
  secret: string;
  status: WebhookSubscriptionStatus;
  createdAt: string;
}

export interface WebhookSubscriptionCriteria {
  clientId?: string;
  status?: WebhookSubscriptionStatus;
}

export type PartnerClientRepository = AsyncRepository<PartnerClient, PartnerClientCriteria>;
export type ApiKeyRepository = AsyncRepository<DeveloperApiKey, ApiKeyCriteria>;
export type WebhookSubscriptionRepository = AsyncRepository<
  WebhookSubscription,
  WebhookSubscriptionCriteria
>;

export function partnerClientMatcher(
  criteria: PartnerClientCriteria
): (item: PartnerClient) => boolean {
  return (item) =>
    (!criteria.clientId || item.clientId === criteria.clientId) &&
    (!criteria.status || item.status === criteria.status);
}

export function apiKeyMatcher(criteria: ApiKeyCriteria): (item: DeveloperApiKey) => boolean {
  return (item) =>
    (!criteria.ownerUserId || item.ownerUserId === criteria.ownerUserId) &&
    (!criteria.prefix || item.prefix === criteria.prefix);
}

export function webhookSubscriptionMatcher(
  criteria: WebhookSubscriptionCriteria
): (item: WebhookSubscription) => boolean {
  return (item) =>
    (!criteria.clientId || item.clientId === criteria.clientId) &&
    (!criteria.status || item.status === criteria.status);
}

export class InMemoryPartnerClientRepository
  extends InMemoryRepository<PartnerClient, PartnerClientCriteria>
  implements PartnerClientRepository
{
  constructor(seed: readonly PartnerClient[] = []) {
    super(seed, partnerClientMatcher);
  }
}

export class InMemoryApiKeyRepository
  extends InMemoryRepository<DeveloperApiKey, ApiKeyCriteria>
  implements ApiKeyRepository
{
  constructor(seed: readonly DeveloperApiKey[] = []) {
    super(seed, apiKeyMatcher);
  }
}

export class InMemoryWebhookSubscriptionRepository
  extends InMemoryRepository<WebhookSubscription, WebhookSubscriptionCriteria>
  implements WebhookSubscriptionRepository
{
  constructor(seed: readonly WebhookSubscription[] = []) {
    super(seed, webhookSubscriptionMatcher);
  }
}

export function createInMemoryPartnerClientRepository(
  seed: readonly PartnerClient[] = []
): InMemoryPartnerClientRepository {
  return new InMemoryPartnerClientRepository(seed);
}

export function createInMemoryApiKeyRepository(
  seed: readonly DeveloperApiKey[] = []
): InMemoryApiKeyRepository {
  return new InMemoryApiKeyRepository(seed);
}

export function createInMemoryWebhookSubscriptionRepository(
  seed: readonly WebhookSubscription[] = []
): InMemoryWebhookSubscriptionRepository {
  return new InMemoryWebhookSubscriptionRepository(seed);
}
