import type { AuditEvent } from '@agric-platform/shared';

export interface AuditCriteria {
  actorId?: string;
  entityType?: string;
}

/** Append-only audit event log (admin.audit_events, NDPR/NDPA requirement). */
export interface AuditRepository {
  record(event: AuditEvent): Promise<AuditEvent>;
  list(criteria?: AuditCriteria): Promise<AuditEvent[]>;
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<AuditEvent> {
    this.events.push(event);
    return event;
  }

  async list(criteria?: AuditCriteria): Promise<AuditEvent[]> {
    return this.events.filter(
      (event) =>
        (!criteria?.actorId || event.actorId === criteria.actorId) &&
        (!criteria?.entityType || event.entityType === criteria.entityType)
    );
  }
}

export function createInMemoryAuditRepository(): InMemoryAuditRepository {
  return new InMemoryAuditRepository();
}
