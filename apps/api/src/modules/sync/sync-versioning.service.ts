import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENTITY_VERSION_REPOSITORY } from '../../database/persistence.tokens.js';
import type { EntityVersionRepository } from '../../database/repositories/sync.repository.js';

export interface SyncVersionChange {
  entity: string;
  entityId: string;
  /** Sync scope key (listing sellerId, notification userId, ...). */
  ownerId: string | null;
  actorId: string | null;
  deleted?: boolean;
}

/**
 * Version-bump hook for entity services (Wave SYNCSRV). Entity services call
 * recordChange() AFTER their primary write succeeds; the bump is additive
 * and deliberately non-fatal — a version-ledger failure must never break or
 * roll back the entity write itself (the ledger self-heals on the next
 * write; the gap is visible via /sync/status).
 *
 * No DB trigger exists for this (pgsql-ast-parser cannot parse CREATE
 * TRIGGER — see the design note in 024_sync.sql), so every write path that
 * should be sync-visible calls this hook explicitly.
 */
@Injectable()
export class SyncVersioningService {
  private readonly logger = new Logger(SyncVersioningService.name);

  constructor(
    @Inject(ENTITY_VERSION_REPOSITORY) private readonly versions: EntityVersionRepository
  ) {}

  /** Bumps sync.entity_versions for one record; never throws. */
  async recordChange(change: SyncVersionChange): Promise<void> {
    try {
      await this.versions.bump({
        entity: change.entity,
        entityId: change.entityId,
        ownerId: change.ownerId,
        updatedBy: change.actorId,
        deleted: change.deleted ?? false
      });
    } catch (error) {
      this.logger.warn(
        `sync version bump failed for ${change.entity}/${change.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
