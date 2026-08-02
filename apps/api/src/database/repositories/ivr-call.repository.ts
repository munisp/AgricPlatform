/**
 * IVR call persistence port (wave P6a). Rows map to channels.ivr_calls
 * (infra/postgres/011_ivr.sql). The call-flow engine state is stored as an
 * opaque jsonb blob so the engine itself stays a pure function; the service
 * owns expiry (10-minute inactivity window), the cumulative DTMF history and
 * the idempotent replay cache (lastDigits/lastResponse inside `state`).
 */
export interface IvrCallRecord {
  sessionId: string;
  callerNumber: string;
  /** Opaque engine state plus replay cache keys. */
  state: Record<string, unknown>;
  currentMenu: string;
  /** `*`-separated cumulative DTMF inputs for this call. */
  dtmfHistory: string;
  /** Terminal outcome (completed | abandoned | escalated); unset while active. */
  outcome?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface IvrCallRepository {
  findById(sessionId: string): Promise<IvrCallRecord | undefined>;
  /** Upsert keyed on sessionId. */
  save(record: IvrCallRecord): Promise<IvrCallRecord>;
  remove(sessionId: string): Promise<boolean>;
  /** Deletes every call whose expiry is at/before `nowIso`; returns the count. */
  deleteExpired(nowIso: string): Promise<number>;
}

export class InMemoryIvrCallRepository implements IvrCallRepository {
  private readonly items = new Map<string, IvrCallRecord>();

  async findById(sessionId: string): Promise<IvrCallRecord | undefined> {
    const record = this.items.get(sessionId);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: IvrCallRecord): Promise<IvrCallRecord> {
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

export function createInMemoryIvrCallRepository(): InMemoryIvrCallRepository {
  return new InMemoryIvrCallRepository();
}
