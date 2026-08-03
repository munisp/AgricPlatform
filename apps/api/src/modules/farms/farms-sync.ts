import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { FARM_PLOT_REPOSITORY } from '../../database/persistence.tokens.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import { SyncEntityRegistry } from '../sync/sync-registry.js';
import { FarmsService, SYNC_ENTITY_FARM_PLOT } from './farms.service.js';

/**
 * W-SYNCWRITE: registers `farm_plot` as the first WRITABLE sync entity
 * (docs/sync-protocol.md §2). The descriptor follows the documented
 * extension path — no sync-module changes required:
 *
 * - Reads (getOwnerId/getPayloads) go through the plot repository so pulls
 *   materialise live records and deleted plots surface as tombstones (the
 *   version ledger keeps owner_id, so scoping survives the delete).
 * - Writes (apply) delegate to FarmsService.applySyncedPlot, which enforces
 *   owner scoping, validates the payload and advances sync.entity_versions
 *   via EntityVersionRepository.bumpExpected (CAS on baseVersion).
 *
 * Scope note: the sync engine scopes push/pull to the record owner (or an
 * admin). Field-agent on-behalf capture is NOT routed through sync in v1 —
 * the field-agents module has no plot-capture write path to reuse, so
 * farm_plot sync is farmer-only (plus admin), matching the REST endpoints.
 */
@Injectable()
export class FarmsSyncEntities implements OnModuleInit {
  constructor(
    private readonly registry: SyncEntityRegistry,
    private readonly farms: FarmsService,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: SYNC_ENTITY_FARM_PLOT,
      ownerField: 'ownerUserId',
      writable: true,
      getOwnerId: async (entityId) => (await this.plots.findById(entityId))?.ownerUserId ?? null,
      getPayloads: async (entityIds) => {
        const payloads = new Map<string, unknown>();
        for (const id of entityIds) {
          const plot = await this.plots.findById(id);
          if (plot) {
            payloads.set(id, plot);
          }
        }
        return payloads;
      },
      apply: (actor, item) => this.farms.applySyncedPlot(actor, item)
    });
  }
}
