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
}

export class InMemoryProcessedEventRepository implements ProcessedEventRepository {
  private readonly seen = new Set<string>();

  async tryRecord(consumer: string, eventId: string): Promise<boolean> {
    const key = `${consumer}${eventId}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    return true;
  }

  async has(consumer: string, eventId: string): Promise<boolean> {
    return this.seen.has(`${consumer}${eventId}`);
  }
}

export function createInMemoryProcessedEventRepository(): InMemoryProcessedEventRepository {
  return new InMemoryProcessedEventRepository();
}
