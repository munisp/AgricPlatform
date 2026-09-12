import type pg from 'pg';
import type {
  BridgeSyncState,
  BridgeSyncStateRepository
} from './bridge-sync-state.repository.js';

/**
 * PostgreSQL bridge sync-state repository over
 * integrations.bridge_sync_state (WP-G20, migration 063). The mapper lives
 * next to the repository (phase3 convention) to keep the wave additive and
 * conflict-free with concurrent changes to pg/row-mappers.ts.
 */
function fromRow(row: Record<string, unknown>): BridgeSyncState {
  return {
    bridge: row.bridge as BridgeSyncState['bridge'],
    lastSyncedAt:
      row.last_synced_at instanceof Date || typeof row.last_synced_at === 'string'
        ? new Date(row.last_synced_at as string).toISOString()
        : undefined,
    lastStatus: row.last_status as BridgeSyncState['lastStatus'],
    payloadHash: (row.payload_hash as string) ?? undefined,
    detail: (row.detail as string) ?? undefined
  };
}

export class PgBridgeSyncStateRepository implements BridgeSyncStateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(bridge: BridgeSyncState['bridge']): Promise<BridgeSyncState | undefined> {
    const result = await this.pool.query(
      'SELECT bridge, last_synced_at, last_status, payload_hash, detail FROM integrations.bridge_sync_state WHERE bridge = $1',
      [bridge]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async upsert(state: BridgeSyncState): Promise<BridgeSyncState> {
    await this.pool.query(
      `INSERT INTO integrations.bridge_sync_state
         (bridge, last_synced_at, last_status, payload_hash, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bridge) DO UPDATE SET
         last_synced_at = EXCLUDED.last_synced_at,
         last_status = EXCLUDED.last_status,
         payload_hash = EXCLUDED.payload_hash,
         detail = EXCLUDED.detail,
         updated_at = now()`,
      [
        state.bridge,
        state.lastSyncedAt ?? null,
        state.lastStatus,
        state.payloadHash ?? null,
        state.detail ?? null
      ]
    );
    return state;
  }

  async all(): Promise<BridgeSyncState[]> {
    const result = await this.pool.query(
      'SELECT bridge, last_synced_at, last_status, payload_hash, detail FROM integrations.bridge_sync_state ORDER BY bridge'
    );
    return result.rows.map(fromRow);
  }
}

export function createPgBridgeSyncStateRepository(pool: pg.Pool): PgBridgeSyncStateRepository {
  return new PgBridgeSyncStateRepository(pool);
}
