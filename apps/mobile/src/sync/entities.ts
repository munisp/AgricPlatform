/**
 * Sync entity keys this app participates in (docs/sync-protocol.md §2).
 *
 * `farm_plot` (W-SYNCWRITE) is the first WRITABLE entity: PlotCaptureScreen
 * enqueues plot mutations into the record-level outbox and the connectivity
 * sync flushes them through POST /sync/push. `notification` remains the
 * read-only pull entity. `marketplace_listing` is registered server-side
 * but not pulled by the app yet.
 */
export const SYNC_ENTITY_FARM_PLOT = 'farm_plot';
export const SYNC_ENTITY_NOTIFICATION = 'notification';

/** Entities pulled by the connectivity/foreground sync (App.tsx). */
export const SYNC_ENTITIES = [SYNC_ENTITY_NOTIFICATION, SYNC_ENTITY_FARM_PLOT] as const;
