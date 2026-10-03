/**
 * Consumer-side idempotency ledger (events.processed_events). Listeners
 * record each domain event they handled; duplicates (redelivered by the
 * outbox sweeper) are ignored atomically.
 */
export interface ProcessedEventRepository {
  /**
   * Records (consumer, eventId) atomically. Returns true when this call did
   * the insert (first delivery) and false when the pair already existed
   * (duplicate — the listener must skip handling).
   */
  tryRecord(consumer: string, eventId: string): Promise<boolean>;
  has(consumer: string, eventId: string): Promise<boolean>;
  /** Retention sweeper (GAP-L11): rows whose processed_at < cutoff. */
  countProcessedBefore(cutoff: string): Promise<number>;
  /**
   * Retention sweeper (GAP-L11): hard-deletes ONE batch of up to `limit`
   * oldest rows whose processed_at < cutoff, so a single statement never
   * locks the whole ledger; the caller loops until a short batch. The rows
   * are pure dedupe markers (consumer, event_id, processed_at) — there is
   * no payload to anonymize, only purge. Returns rows deleted.
   */
  purgeProcessedBefore(cutoff: string, limit: number): Promise<number>;
}

const keyFor = (consumer: string, eventId: string) => `${consumer} ${eventId}`;

export class InMemoryProcessedEventRepository implements ProcessedEventRepository {
  /** Dedupe key -> processed_at ISO timestamp (retention needs the age). */
  private readonly seen = new Map<string, string>();

  constructor(seed: readonly { consumer: string; eventId: string; processedAt: string }[] = []) {
    for (const row of seed) {
      this.seen.set(keyFor(row.consumer, row.eventId), row.processedAt);
    }
  }

  async tryRecord(consumer: string, eventId: string): Promise<boolean> {
    const key = keyFor(consumer, eventId);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, new Date().toISOString());
    return true;
  }

  async has(consumer: string, eventId: string): Promise<boolean> {
    return this.seen.has(keyFor(consumer, eventId));
  }

  async countProcessedBefore(cutoff: string): Promise<number> {
    return [...this.seen.values()].filter((processedAt) => processedAt < cutoff).length;
  }

  async purgeProcessedBefore(cutoff: string, limit: number): Promise<number> {
    const expired = [...this.seen.entries()]
      .filter(([, processedAt]) => processedAt < cutoff)
      // Oldest first, mirroring the pg ORDER BY processed_at ASC LIMIT n batch.
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, Math.max(0, limit));
    for (const [key] of expired) {
      this.seen.delete(key);
    }
    return expired.length;
  }
}

export function createInMemoryProcessedEventRepository(): InMemoryProcessedEventRepository {
  return new InMemoryProcessedEventRepository();
}
