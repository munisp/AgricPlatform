import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ENTITY_VERSION_REPOSITORY,
  SYNC_CURSOR_REPOSITORY,
  SYNC_MUTATION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  EntityVersionRepository,
  SyncCursorRepository,
  SyncMutationRepository
} from '../../database/repositories/sync.repository.js';
import { SyncEntityRegistry } from './sync-registry.js';
import {
  SYNC_PULL_LIMIT_DEFAULT,
  SYNC_PULL_LIMIT_MAX,
  type SyncPullPage,
  type SyncPushItem,
  type SyncPushItemResult,
  type SyncStatusEntry
} from './sync.types.js';

/**
 * Sync protocol v1 engine (Wave SYNCSRV; docs/sync-protocol.md).
 *
 * Push semantics (server-wins for v1):
 *   1. Idempotency first: a recorded (user, clientMutationId) replays its
 *      ORIGINAL outcome — applied and conflict results only; transient
 *      errors are never ledgered so retries can succeed later.
 *   2. Owner scoping: the caller must own the record (registry accessor) or
 *      be an admin; creating a record makes the caller its owner.
 *   3. Optimistic concurrency: baseVersion must equal the current server
 *      version (0 for creates) or the item is a per-item CONFLICT carrying
 *      the server version + payload. Nothing is silently overwritten.
 *   4. Applied items bump sync.entity_versions atomically (bumpExpected) and
 *      emit audit + a domain event.
 *
 * Pull semantics: owner-scoped, version-ordered pages out of
 * sync.entity_versions; the cursor is the max version returned (monotonic
 * per (user, entity)); deletes travel as tombstones (deleted + null payload).
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly registry: SyncEntityRegistry,
    @Inject(ENTITY_VERSION_REPOSITORY) private readonly versions: EntityVersionRepository,
    @Inject(SYNC_CURSOR_REPOSITORY) private readonly cursors: SyncCursorRepository,
    @Inject(SYNC_MUTATION_REPOSITORY) private readonly mutations: SyncMutationRepository,
    private readonly events: DomainEventsService,
    private readonly audit: AuditService
  ) {}

  async push(actor: User, items: readonly SyncPushItem[]): Promise<SyncPushItemResult[]> {
    const results: SyncPushItemResult[] = [];
    for (const item of items) {
      results.push(await this.pushItem(actor, item));
    }
    return results;
  }

  private async pushItem(actor: User, item: SyncPushItem): Promise<SyncPushItemResult> {
    const base: Pick<SyncPushItemResult, 'entity' | 'entityId' | 'clientMutationId'> = {
      entity: item.entity,
      entityId: item.entityId,
      clientMutationId: item.clientMutationId
    };

    const descriptor = this.registry.get(item.entity);
    if (!descriptor) {
      return { ...base, status: 'error', error: 'unknown_entity' };
    }

    // Idempotent replay: the ledgered outcome wins over re-processing.
    const recorded = await this.mutations.find(actor.id, item.clientMutationId);
    if (recorded) {
      if (recorded.entity !== item.entity || recorded.entityId !== item.entityId || recorded.op !== item.op) {
        // Same id, different mutation: client bug — refuse (fail-closed).
        return { ...base, status: 'error', error: 'mutation_id_reused' };
      }
      return recorded.detail
        ? (recorded.detail as unknown as SyncPushItemResult)
        : { ...base, status: 'error', error: 'replay_unavailable' };
    }

    const result = await this.processPushItem(actor, item, descriptor.writable);
    // Only deterministic data outcomes are ledgered; transient errors are
    // recomputed on retry (authz/validation errors are deterministic too,
    // but keeping the ledger to applied/conflict mirrors the
    // events.processed_events "handled" semantics).
    if (result.status === 'applied' || result.status === 'conflict') {
      const ledgered = await this.mutations.record({
        userId: actor.id,
        clientMutationId: item.clientMutationId,
        entity: item.entity,
        entityId: item.entityId,
        op: item.op,
        status: result.status,
        newVersion: result.newVersion ?? null,
        detail: { ...result },
        createdAt: new Date().toISOString()
      });
      if (!ledgered) {
        // A concurrent request recorded first: replay ITS outcome.
        const winner = await this.mutations.find(actor.id, item.clientMutationId);
        if (winner?.detail) {
          return winner.detail as unknown as SyncPushItemResult;
        }
      }
    }
    return result;
  }

  private async processPushItem(
    actor: User,
    item: SyncPushItem,
    writable: boolean
  ): Promise<SyncPushItemResult> {
    const base = { entity: item.entity, entityId: item.entityId, clientMutationId: item.clientMutationId };
    const descriptor = this.registry.get(item.entity)!;

    if (!writable || !descriptor.apply) {
      return { ...base, status: 'error', error: 'read_only_entity' };
    }

    // Owner scoping: only the record owner (or an admin) may mutate.
    const ownerId = await descriptor.getOwnerId(item.entityId);
    const isCreate = ownerId === null;
    if (!isCreate && ownerId !== actor.id && !actor.roles.includes('admin')) {
      return { ...base, status: 'error', error: 'forbidden' };
    }

    // Optimistic concurrency: baseVersion must match the server exactly.
    const current = await this.versions.current(item.entity, item.entityId);
    const currentVersion = current?.version ?? 0;
    if (item.baseVersion !== currentVersion) {
      const payloads = await descriptor.getPayloads([item.entityId]);
      return {
        ...base,
        status: 'conflict',
        serverVersion: currentVersion,
        serverPayload: payloads.get(item.entityId) ?? null
      };
    }

    try {
      const newVersion = await descriptor.apply(actor, item);
      await this.audit.record({
        actorId: actor.id,
        action: `sync.push.${item.op}`,
        entityType: item.entity,
        entityId: item.entityId,
        metadata: { clientMutationId: item.clientMutationId, baseVersion: item.baseVersion, newVersion }
      });
      await this.events.publish(
        'sync.mutation.applied',
        {
          entity: item.entity,
          entityId: item.entityId,
          op: item.op,
          baseVersion: item.baseVersion,
          newVersion,
          clientMutationId: item.clientMutationId
        },
        actor.id
      );
      return { ...base, status: 'applied', newVersion };
    } catch (error) {
      this.logger.warn(
        `sync push apply failed for ${item.entity}/${item.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { ...base, status: 'error', error: 'apply_failed' };
    }
  }

  async pull(actor: User, entity: string, since: number, limit?: number): Promise<SyncPullPage> {
    const descriptor = this.registry.get(entity);
    if (!descriptor) {
      throw new BadRequestException(`Unknown sync entity '${entity}'`);
    }
    if (!Number.isInteger(since) || since < 0) {
      throw new BadRequestException('`since` must be a non-negative integer cursor');
    }
    const pageSize = Math.min(Math.max(limit ?? SYNC_PULL_LIMIT_DEFAULT, 1), SYNC_PULL_LIMIT_MAX);

    const rows = await this.versions.listSince(entity, actor.id, since, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const liveIds = page.filter((row) => !row.deleted).map((row) => row.entityId);
    const payloads = await descriptor.getPayloads(liveIds);

    const items = page.map((row) => {
      const payload = row.deleted ? undefined : payloads.get(row.entityId);
      return {
        entityId: row.entityId,
        version: row.version,
        // A live version row whose source record is gone is served as a
        // tombstone so clients purge their stale copy (fail-closed).
        deleted: row.deleted || payload === undefined,
        payload: payload ?? null
      };
    });

    // Cursor = max version seen in this page; never regresses, even on an
    // empty page (monotonic per (user, entity)).
    const cursor = page.length > 0 ? page[page.length - 1].version : since;
    await this.cursors.set(actor.id, entity, cursor);

    return { entity, items, cursor, hasMore };
  }

  async status(actor: User): Promise<SyncStatusEntry[]> {
    const entries: SyncStatusEntry[] = [];
    for (const entity of this.registry.list()) {
      entries.push({
        entity,
        serverMaxVersion: await this.versions.maxVersion(entity, actor.id),
        cursor: await this.cursors.get(actor.id, entity)
      });
    }
    return entries;
  }
}
