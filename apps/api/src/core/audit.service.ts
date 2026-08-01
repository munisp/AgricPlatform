import { Injectable } from '@nestjs/common';
import type { AuditEvent } from '@agric-platform/shared';
import { newId } from '../common/in-memory.repository.js';

export interface RecordAuditInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log for admin and sensitive operations (NDPR/NDPA requirement).
 * Phase 1 stores events in memory; production persists to the PostgreSQL
 * audit_events table behind the same interface.
 */
@Injectable()
export class AuditService {
  private readonly events: AuditEvent[] = [];

  record(input: RecordAuditInput): AuditEvent {
    const event: AuditEvent = {
      id: newId('audit'),
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString()
    };
    this.events.push(event);
    return event;
  }

  list(filter?: { actorId?: string; entityType?: string }): AuditEvent[] {
    return this.events.filter(
      (event) =>
        (!filter?.actorId || event.actorId === filter.actorId) &&
        (!filter?.entityType || event.entityType === filter.entityType)
    );
  }
}
