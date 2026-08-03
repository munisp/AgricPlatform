import { Module } from '@nestjs/common';
import { SyncEntityRegistry } from './sync-registry.js';
import { SyncProofEntities } from './sync-proof-entities.js';
import { SyncVersioningService } from './sync-versioning.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

/**
 * Sync protocol v1 (Wave SYNCSRV; docs/sync-protocol.md). Imports nothing
 * from feature modules — proof entities are wired over the global
 * repositories — so feature modules (marketplace, notifications, and later
 * farms) can import SyncModule for SyncVersioningService / the registry
 * without creating import cycles.
 */
@Module({
  controllers: [SyncController],
  providers: [SyncEntityRegistry, SyncProofEntities, SyncVersioningService, SyncService],
  exports: [SyncEntityRegistry, SyncVersioningService, SyncService]
})
export class SyncModule {}
