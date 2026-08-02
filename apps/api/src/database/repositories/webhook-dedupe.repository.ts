import { newId } from '../../common/async-repository.js';

/**
 * Durable provider-webhook dedupe port (funds-integrity wave). Replaces the
 * per-process in-memory replay cache so a restart or a second API instance
 * cannot reprocess a verified webhook. The PostgreSQL implementation reuses
 * integrations.inbound_events with its UNIQUE (system, dedupe_key)
 * constraint (007_phase3_integrations.sql) as the atomic check-and-insert.
 */
export interface WebhookDedupeStore {
  /**
   * Atomically records the digest. Returns true when the digest is new
   * (caller proceeds with side effects) and false on a replay.
   */
  recordIfNew(provider: string, digest: string, payload: unknown): Promise<boolean>;
}

/** Bounded per-provider replay cache (development/in-memory mode). */
const REPLAY_CACHE_LIMIT = 1000;

export class InMemoryWebhookDedupeStore implements WebhookDedupeStore {
  private readonly seen = new Map<string, string[]>();

  async recordIfNew(provider: string, digest: string, _payload: unknown): Promise<boolean> {
    const digests = this.seen.get(provider) ?? [];
    if (digests.includes(digest)) {
      return false;
    }
    digests.push(digest);
    if (digests.length > REPLAY_CACHE_LIMIT) {
      digests.shift();
    }
    this.seen.set(provider, digests);
    return true;
  }
}

export function createInMemoryWebhookDedupeStore(): InMemoryWebhookDedupeStore {
  return new InMemoryWebhookDedupeStore();
}

/** Row shape shared with the pg implementation (phase3.pg-repository.ts). */
export function webhookDedupeRow(provider: string, digest: string, payload: unknown) {
  return {
    id: newId('webhook'),
    system: provider,
    eventType: 'provider_webhook',
    dedupeKey: digest,
    payload: payload ?? {}
  };
}
