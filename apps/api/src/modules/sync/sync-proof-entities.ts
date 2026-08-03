import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  LISTING_REPOSITORY,
  NOTIFICATION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import { SyncEntityRegistry } from './sync-registry.js';

/** Protocol entity names (docs/sync-protocol.md §4). */
export const SYNC_ENTITY_MARKETPLACE_LISTING = 'marketplace_listing';
export const SYNC_ENTITY_NOTIFICATION = 'notification';

/**
 * v1 proof registrations (Wave SYNCSRV): marketplace listings and
 * notifications opted into sync READ paths. Both are server-authoritative
 * (writable: false) — clients pull them; pushes are rejected per item with
 * `read_only_entity`.
 *
 * Extensibility contract for later waves (e.g. farms): inject
 * SyncEntityRegistry in the owning module and register a descriptor backed
 * by that module's repository; set `writable: true` and provide `apply()`
 * (advancing sync.entity_versions via EntityVersionRepository.bumpExpected)
 * to accept pushes. No sync-module changes required.
 */
@Injectable()
export class SyncProofEntities implements OnModuleInit {
  constructor(
    private readonly registry: SyncEntityRegistry,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: SYNC_ENTITY_MARKETPLACE_LISTING,
      ownerField: 'sellerId',
      writable: false,
      getOwnerId: async (entityId) => (await this.listings.findById(entityId))?.sellerId ?? null,
      getPayloads: async (entityIds) => {
        const payloads = new Map<string, unknown>();
        for (const id of entityIds) {
          const listing = await this.listings.findById(id);
          if (listing) {
            payloads.set(id, listing);
          }
        }
        return payloads;
      }
    });

    this.registry.register({
      name: SYNC_ENTITY_NOTIFICATION,
      ownerField: 'userId',
      writable: false,
      getOwnerId: async (entityId) => (await this.notifications.findById(entityId))?.userId ?? null,
      getPayloads: async (entityIds) => {
        const payloads = new Map<string, unknown>();
        for (const id of entityIds) {
          const message = await this.notifications.findById(id);
          if (message) {
            payloads.set(id, message);
          }
        }
        return payloads;
      }
    });
  }
}
