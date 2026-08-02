import type { DeliveryResult } from '../../modules/integrations/adapters.js';

export interface DeliveryLogEntry {
  notificationId: string;
  result: DeliveryResult;
  at: string;
  /** 1-based delivery attempt number (Wave P retry/DLQ). */
  attempt?: number;
  /** When the next retry becomes due (failed, non-dead-lettered entries). */
  nextRetryAt?: string;
  /** Set when the entry exhausted max attempts (dead letter). */
  deadLetteredAt?: string;
}

export interface DeliveryLogCriteria {
  notificationId?: string;
}

/** Append-only delivery log (notifications.delivery_logs). */
export interface DeliveryLogRepository {
  append(entry: DeliveryLogEntry): Promise<DeliveryLogEntry>;
  list(criteria?: DeliveryLogCriteria): Promise<DeliveryLogEntry[]>;
}

export class InMemoryDeliveryLogRepository implements DeliveryLogRepository {
  private readonly entries: DeliveryLogEntry[] = [];

  async append(entry: DeliveryLogEntry): Promise<DeliveryLogEntry> {
    this.entries.push({ ...entry });
    return entry;
  }

  async list(criteria?: DeliveryLogCriteria): Promise<DeliveryLogEntry[]> {
    return this.entries
      .filter(
        (entry) => !criteria?.notificationId || entry.notificationId === criteria.notificationId
      )
      .map((entry) => ({ ...entry }));
  }
}

export function createInMemoryDeliveryLogRepository(): InMemoryDeliveryLogRepository {
  return new InMemoryDeliveryLogRepository();
}
