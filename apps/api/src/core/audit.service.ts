import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '@agric-platform/shared';
import { newId } from '../common/async-repository.js';
import { AUDIT_REPOSITORY } from '../database/persistence.tokens.js';
import type { AuditCriteria, AuditRepository } from '../database/repositories/audit.repository.js';

export interface RecordAuditInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log for admin and sensitive operations (NDPR/NDPA requirement).
 * Persists through the injected AuditRepository (in-memory by default,
 * admin.audit_events in PostgreSQL).
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audits: AuditRepository
  ) {}

  async record(input: RecordAuditInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: newId('audit'),
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString()
    };
    return this.audits.record(event);
  }

  async list(filter?: AuditCriteria): Promise<AuditEvent[]> {
    return this.audits.list(filter);
  }
}
