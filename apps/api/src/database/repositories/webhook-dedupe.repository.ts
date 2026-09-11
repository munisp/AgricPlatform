import { newId } from '../../common/async-repository.js';

/** A recorded webhook whose processing state is tracked for crash recovery. */
export interface RecordedWebhook {
  provider: string;
  /** Dedupe key (signature digest or payload hash). */
  digest: string;
  payload: unknown;
  receivedAt?: string;
}

/**
 * Durable provider-webhook dedupe port (funds-integrity wave). Replaces the
 * per-process in-memory replay cache so a restart or a second API instance
 * cannot reprocess a verified webhook. The PostgreSQL implementation reuses
 * integrations.inbound_events with its UNIQUE (system, dedupe_key)
 * constraint (007_phase3_integrations.sql) as the atomic check-and-insert.
 *
 * Audit C2: recording alone is not enough — a webhook recorded BEFORE its
 * side effects ran (audit + domain-event publish) would be permanently lost
 * when processing failed transiently, because the provider retry would be
 * answered as a bare duplicate. Implementations therefore track a
 * processed marker (the existing `processed_at` column in PostgreSQL): a
 * replay of an UNPROCESSED record is re-driven, and `markProcessed` runs
 * only after the side effects succeed.
 */
export interface WebhookDedupeStore {
  /**
   * Atomically records the digest. Returns true when the digest is new
   * (caller proceeds with side effects) and false on a replay.
   */
  recordIfNew(provider: string, digest: string, payload: unknown): Promise<boolean>;
  /**
   * Marks a recorded webhook processed. Called ONLY after the side effects
   * succeeded; until then a replay must re-drive processing.
   */
  markProcessed(provider: string, digest: string): Promise<void>;
  /** True when the recorded webhook's side effects completed. */
  isProcessed(provider: string, digest: string): Promise<boolean>;
  /**
   * Recorded webhooks whose processing never completed (crash recovery).
   * Drained by the admin reprocessor sweep.
   */
  listUnprocessed(limit?: number): Promise<RecordedWebhook[]>;
}

/** Bounded per-provider replay cache (development/in-memory mode). */
const REPLAY_CACHE_LIMIT = 1000;

interface InMemoryWebhookRecord extends RecordedWebhook {
  processed: boolean;
}

export class InMemoryWebhookDedupeStore implements WebhookDedupeStore {
  private readonly seen = new Map<string, InMemoryWebhookRecord[]>();

  async recordIfNew(provider: string, digest: string, payload: unknown): Promise<boolean> {
    const records = this.seen.get(provider) ?? [];
    if (records.some((record) => record.digest === digest)) {
      return false;
    }
    records.push({
      provider,
      digest,
      payload,
      receivedAt: new Date().toISOString(),
      processed: false
    });
    if (records.length > REPLAY_CACHE_LIMIT) {
      records.shift();
    }
    this.seen.set(provider, records);
    return true;
  }

  async markProcessed(provider: string, digest: string): Promise<void> {
    const record = (this.seen.get(provider) ?? []).find((entry) => entry.digest === digest);
    if (record) {
      record.processed = true;
    }
  }

  async isProcessed(provider: string, digest: string): Promise<boolean> {
    return (
      (this.seen.get(provider) ?? []).find((entry) => entry.digest === digest)?.processed === true
    );
  }

  async listUnprocessed(limit = 100): Promise<RecordedWebhook[]> {
    const pending: RecordedWebhook[] = [];
    for (const records of this.seen.values()) {
      for (const record of records) {
        if (!record.processed) {
          pending.push(record);
        }
      }
    }
    return pending.slice(0, limit);
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
