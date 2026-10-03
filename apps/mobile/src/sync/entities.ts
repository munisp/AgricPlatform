/**
 * Sync entity keys this app participates in (docs/sync-protocol.md §2).
 *
 * `farm_plot` (W-SYNCWRITE) is the first WRITABLE entity: PlotCaptureScreen
 * enqueues plot mutations into the record-level outbox and the connectivity
 * sync flushes them through POST /sync/push. `notification` and
 * `marketplace_listing` (GAP-M26) are read-only pull entities — the server
 * is the only writer. Listing pulls are owner-scoped server-side (a seller
 * syncs their OWN listings), so MarketplaceScreen merges the cache into the
 * live list and serves it as the offline fallback.
 */
export const SYNC_ENTITY_FARM_PLOT = 'farm_plot';
export const SYNC_ENTITY_NOTIFICATION = 'notification';
export const SYNC_ENTITY_MARKETPLACE_LISTING = 'marketplace_listing';

/** Entities pulled by the connectivity/foreground sync (App.tsx). */
export const SYNC_ENTITIES = [
  SYNC_ENTITY_NOTIFICATION,
  SYNC_ENTITY_FARM_PLOT,
  SYNC_ENTITY_MARKETPLACE_LISTING
] as const;
