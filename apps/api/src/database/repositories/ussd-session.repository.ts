/**
 * USSD session persistence port (wave P5b). Rows map to
 * channels.ussd_sessions (infra/postgres/008_ussd_channels.sql). The menu
 * engine state is stored as an opaque jsonb blob so the engine itself stays
 * a pure function; the service owns expiry (3-minute inactivity window) and
 * the idempotent replay cache (lastText/lastResponse inside `state`).
 */
export interface UssdSessionRecord {
  sessionId: string;
  phone: string;
  msisdn: string;
  /** Opaque engine state plus replay cache keys. */
  state: Record<string, unknown>;
  currentMenu: string;
  createdAt: string;
  expiresAt: string;
}

export interface UssdSessionRepository {
  findById(sessionId: string): Promise<UssdSessionRecord | undefined>;
  /** Upsert keyed on sessionId. */
  save(record: UssdSessionRecord): Promise<UssdSessionRecord>;
  remove(sessionId: string): Promise<boolean>;
  /** Deletes every session whose expiry is at/before `nowIso`; returns the count. */
  deleteExpired(nowIso: string): Promise<number>;
}

export class InMemoryUssdSessionRepository implements UssdSessionRepository {
  private readonly items = new Map<string, UssdSessionRecord>();

  async findById(sessionId: string): Promise<UssdSessionRecord | undefined> {
    const record = this.items.get(sessionId);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: UssdSessionRecord): Promise<UssdSessionRecord> {
    this.items.set(record.sessionId, structuredClone(record));
    return structuredClone(record);
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.items.delete(sessionId);
  }

  async deleteExpired(nowIso: string): Promise<number> {
    let removed = 0;
    for (const [sessionId, record] of this.items) {
      if (record.expiresAt <= nowIso) {
        this.items.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }
}

export function createInMemoryUssdSessionRepository(): InMemoryUssdSessionRepository {
  return new InMemoryUssdSessionRepository();
}
