import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import { createInMemoryEntityVersionRepository } from '../../database/repositories/sync.repository.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SYNC_ENTITY_MARKETPLACE_LISTING, SYNC_ENTITY_NOTIFICATION } from './sync-proof-entities.js';
import { SyncVersioningService } from './sync-versioning.service.js';

/**
 * Wave SYNCSRV version-wiring: writes through the two proof entities'
 * services bump sync.entity_versions via the (optional) SyncVersioningService
 * hook. Bumps are additive — the same flows work unchanged without the hook.
 */

function makeMarketplace(withVersioning: boolean) {
  const versions = createInMemoryEntityVersionRepository();
  const versioning = new SyncVersioningService(versions);
  const listings = createInMemoryListingRepository();
  const service = new MarketplaceService(
    new DomainEventsService(createInMemoryOutboxRepository()),
    listings,
    createInMemoryOrderRepository(listings),
    createInMemoryReviewRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    withVersioning ? versioning : undefined
  );
  return { service, versions };
}

const listingInput = {
  sellerId: 'user-seller',
  kind: 'produce' as const,
  title: 'Maize 100kg',
  quantity: 100,
  unit: 'kg',
  priceNaira: 45000,
  location: { state: 'Kaduna', lga: 'Zaria' }
};

describe('MarketplaceService sync version bumps', () => {
  it('bumps marketplace_listing to v1 on create with the seller as owner', async () => {
    const { service, versions } = makeMarketplace(true);
    const created = await service.createListing(listingInput);
    const row = await versions.current(SYNC_ENTITY_MARKETPLACE_LISTING, created.id);
    expect(row).toMatchObject({ version: 1, ownerId: 'user-seller', deleted: false });
  });

  it('bumps again on update, preserving the owner scope', async () => {
    const { service, versions } = makeMarketplace(true);
    const created = await service.createListing(listingInput);
    await service.updateListing(created.id, { priceNaira: 46000 }, 'user-seller');
    const row = await versions.current(SYNC_ENTITY_MARKETPLACE_LISTING, created.id);
    expect(row!.version).toBe(2);
    expect(row!.ownerId).toBe('user-seller');
  });

  it('writes behave identically when the hook is absent (additive)', async () => {
    const { service, versions } = makeMarketplace(false);
    const created = await service.createListing(listingInput);
    expect(created.title).toBe('Maize 100kg');
    expect(await versions.current(SYNC_ENTITY_MARKETPLACE_LISTING, created.id)).toBeUndefined();
  });
});

function makeNotifications() {
  const versions = createInMemoryEntityVersionRepository();
  const versioning = new SyncVersioningService(versions);
  const integrations = {
    deliver: () => ({ delivered: true, provider: 'stub', providerRef: 'r-1' })
  } as unknown as IntegrationsService;
  const service = new NotificationsService(
    new DomainEventsService(createInMemoryOutboxRepository()),
    integrations,
    createInMemoryNotificationRepository(),
    { find: async () => undefined } as never,
    { append: async () => ({}) } as never,
    versioning
  );
  return { service, versions };
}

describe('NotificationsService sync version bumps', () => {
  it('bumps notification on send with the recipient as owner', async () => {
    const { service, versions } = makeNotifications();
    const message = await service.send({
      userId: 'user-1',
      channel: 'in_app',
      title: 'Hello',
      body: 'World'
    });
    const row = await versions.current(SYNC_ENTITY_NOTIFICATION, message.id);
    expect(row).toMatchObject({ version: 1, ownerId: 'user-1' });
  });

  it('bumps notification again on markRead', async () => {
    const { service, versions } = makeNotifications();
    const message = await service.send({
      userId: 'user-1',
      channel: 'in_app',
      title: 'Hello',
      body: 'World'
    });
    await service.markRead(message.id);
    expect((await versions.current(SYNC_ENTITY_NOTIFICATION, message.id))!.version).toBe(2);
  });
});

describe('SyncVersioningService failure isolation', () => {
  it('swallows ledger failures instead of breaking the primary write', async () => {
    const failing = {
      bump: async () => {
        throw new Error('ledger down');
      }
    };
    const versioning = new SyncVersioningService(failing as never);
    await expect(
      versioning.recordChange({ entity: 'e', entityId: 'id', ownerId: 'u', actorId: 'u' })
    ).resolves.toBeUndefined();
  });
});
