import { Module } from '@nestjs/common';
import type pg from 'pg';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { EVIDENCE_ITEM_REPOSITORY, PG_POOL } from '../../database/persistence.tokens.js';
import { createInMemoryEvidenceItemRepository } from '../../database/repositories/evidence-item.repository.js';
import { createPgEvidenceItemRepository } from '../../database/repositories/evidence-item.pg-repository.js';
import {
  CASE_PARTICIPANT_LOOKUP,
  createCaseParticipantLookup
} from './case-participants.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceService } from './evidence.service.js';
import {
  createEvidenceStorageDriver,
  EVIDENCE_STORAGE_DRIVER
} from './evidence.storage.js';

/**
 * Evidence Locker (Stage 27 Innovation 13, additive; flag `evidence-locker`,
 * default OFF). Hash-chained dispute evidence packs pinned to
 * escrow/vsla/insurance/pool cases: blobs in S3-compatible object storage
 * (the analytics lakehouse driver path), references + per-case hash chains
 * in Postgres (migration 071), seals frozen into the platform audit chain.
 *
 * Bindings live here next to their only consumer (AUDIT_ANCHOR_REPOSITORY
 * precedent in CoreModule): the repository follows the global PG_POOL
 * presence rule, the case-participant lookup fails CLOSED (503) when no
 * pool exists, and the storage driver is the deterministic fail-closed stub
 * unless EVIDENCE_STORAGE_DRIVER=s3 is configured.
 */
@Module({
  controllers: [EvidenceController],
  providers: [
    EvidenceService,
    {
      provide: EVIDENCE_ITEM_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEvidenceItemRepository(pool) : createInMemoryEvidenceItemRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CASE_PARTICIPANT_LOOKUP,
      useFactory: (pool: pg.Pool | null) => createCaseParticipantLookup(pool),
      inject: [PG_POOL]
    },
    {
      provide: EVIDENCE_STORAGE_DRIVER,
      useFactory: (telemetry: TelemetryService) =>
        createEvidenceStorageDriver(process.env, telemetry),
      inject: [TelemetryService]
    }
  ],
  // Exported for the privacy module's NDPA deletion sweep.
  exports: [EvidenceService]
})
export class EvidenceModule {}
