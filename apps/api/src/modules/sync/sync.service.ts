import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
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
  SYNC_PROTOCOL_VERSION,
  SYNC_PULL_LIMIT_DEFAULT,
  SYNC_PULL_LIMIT_MAX,
  SYNC_RESYNC_REQUIRED_MESSAGE,
  SyncVersionConflictError,
  type SyncPullPage,
  type SyncPushItem,
  type SyncPushItemResult,
  type SyncStatusEntry
} from './sync.types.js';

/**
 * Sync protocol v2 engine (Wave SYNCSRV + FP-4; docs/sync-protocol.md).
 *
 * Push semantics (server-wins):
 *   1. Idempotency first: a recorded (user, clientMutationId) replays its
 *      ORIGINAL outcome — applied results only; conflicts are recomputed on
 *      retry (never ledgered, so a stale recorded payload can never
 *      regress a fresher client cache) and transient errors are never
 *      ledgered so retries can succeed later.
 *   2. Owner scoping: the caller must own the record or be an admin.
 *      Ownership resolves from the live source row OR, for deleted records,
 *      from the version ledger's owner_id — a create-style push over a
 *      FOREIGN tombstone is `forbidden` (no serverVersion oracle leaks).
 *   3. Optimistic concurrency: baseVersion must equal the current server
 *      version (0 for creates) or the item is a per-item CONFLICT carrying
 *      the server version + payload. Nothing is silently overwritten.
 *   4. Applied items claim sync.entity_versions atomically AROUND the entity
 *      write (applyGuarded): a concurrent claimant can never write the
 *      source row; a lost claim surfaces as CONFLICT, not apply_failed.
 *
 * Pull semantics (v2): owner-scoped pages ordered by the GLOBAL monotonic
 * change_seq; the cursor is the max change_seq returned (monotonic per
 * (user, entity)); deletes travel as tombstones (deleted + null payload).
 * Pulls with a non-zero `since` must declare protocol v=2 — a v1 cursor is
 * answered 409 sync_resync_required so legacy devices resync loudly
 * instead of silently diverging.
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
    // Perf P2-7: independent items process concurrently instead of strictly
    // sequentially. Ordering IS contract-relevant within one (entity,
    // entityId) — a later push must observe the earlier push's version bump
    // and a replayed clientMutationId must see the recorded outcome — so
    // same-record items keep their original sequential order while
    // different records run in parallel. Results land at their original
    // indices, per-item failure isolation is unchanged (pushItem resolves
    // per-item error results), and a thrown infrastructure error still
    // rejects the batch as before.
    interface Group {
      records: Set<string>;
      mutationIds: Set<string>;
      entries: Array<{ item: SyncPushItem; index: number }>;
    }
    const groups: Group[] = [];
    items.forEach((item, index) => {
      const recordKey = `${item.entity} ${item.entityId}`;
      // An item joins EVERY group it collides with (same record or same
      // clientMutationId); multiple collisions merge the groups so ordering
      // is preserved transitively.
      let target: Group | undefined;
      for (const group of groups) {
        if (group.records.has(recordKey) || group.mutationIds.has(item.clientMutationId)) {
          if (!target) {
            target = group;
          } else {
            for (const key of group.records) target.records.add(key);
            for (const id of group.mutationIds) target.mutationIds.add(id);
            target.entries.push(...group.entries);
            group.entries = [];
            group.records.clear();
            group.mutationIds.clear();
          }
        }
      }
      if (!target) {
        target = { records: new Set(), mutationIds: new Set(), entries: [] };
        groups.push(target);
      }
      target.records.add(recordKey);
      target.mutationIds.add(item.clientMutationId);
      target.entries.push({ item, index });
    });
    const results: SyncPushItemResult[] = new Array(items.length);
    await Promise.all(
      groups
        .filter((group) => group.entries.length > 0)
        .map(async (group) => {
          group.entries.sort((a, b) => a.index - b.index);
          for (const { item, index } of group.entries) {
            results[index] = await this.pushItem(actor, item);
          }
        })
    );
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
    // Only `applied` outcomes are ledgered. Conflicts are RECOMPUTED on
    // retry (v2): a ledgered conflict would replay its stale serverPayload
    // verbatim forever, regressing client caches that have since pulled a
    // fresher version (V-65). Transient errors are likewise never ledgered.
    if (result.status === 'applied') {
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
    // Ownership resolves from the live source row; for DELETED records the
    // live row is gone, so the version ledger's owner_id (captured at bump
    // time) decides — a create-style push over a FOREIGN tombstone is
    // forbidden (V-63: no entityId takeover), and it fails BEFORE the CAS
    // check below so the response carries no serverVersion oracle.
    const current = await this.versions.current(item.entity, item.entityId);
    const liveOwnerId = await descriptor.getOwnerId(item.entityId);
    const effectiveOwnerId = liveOwnerId ?? current?.ownerId ?? null;
    if (effectiveOwnerId !== null && effectiveOwnerId !== actor.id && !actor.roles.includes('admin')) {
      return { ...base, status: 'error', error: 'forbidden' };
    }

    // Optimistic concurrency: baseVersion must match the server exactly.
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
      if (error instanceof SyncVersionConflictError) {
        // V-18: the atomic version-row claim was lost to a concurrent writer
        // BETWEEN the pre-check above and the apply. The losing payload never
        // touched the source row; answer with a fresh conflict (the same
        // contract as a stale baseVersion), not a retryable apply_failed.
        const raced = await this.versions.current(item.entity, item.entityId);
        const payloads = await descriptor.getPayloads([item.entityId]);
        return {
          ...base,
          status: 'conflict',
          serverVersion: raced?.version ?? 0,
          serverPayload: payloads.get(item.entityId) ?? null
        };
      }
      this.logger.warn(
        `sync push apply failed for ${item.entity}/${item.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { ...base, status: 'error', error: 'apply_failed' };
    }
  }

  async pull(
    actor: User,
    entity: string,
    since: number,
    limit?: number,
    protocolVersion?: number
  ): Promise<SyncPullPage> {
    const descriptor = this.registry.get(entity);
    if (!descriptor) {
      throw new BadRequestException(`Unknown sync entity '${entity}'`);
    }
    if (!Number.isInteger(since) || since < 0) {
      throw new BadRequestException('`since` must be a non-negative integer cursor');
    }
    if (since > 0 && protocolVersion !== SYNC_PROTOCOL_VERSION) {
      // v2 guard: a non-zero cursor minted under v1 counts PER-RECORD
      // versions; comparing it against change_seq would silently skip
      // records forever. Fail loudly instead — the client resets to
      // since=0 and performs a full resync (docs/sync-protocol.md §6).
      throw new ConflictException({
        message: SYNC_RESYNC_REQUIRED_MESSAGE,
        error: 'sync_resync_required'
      });
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
        changeSeq: row.changeSeq,
        // A live version row whose source record is gone is served as a
        // tombstone so clients purge their stale copy (fail-closed).
        deleted: row.deleted || payload === undefined,
        payload: payload ?? null
      };
    });

    // Cursor = max change_seq seen in this page; never regresses, even on
    // an empty page (monotonic per (user, entity)).
    const cursor = page.length > 0 ? page[page.length - 1].changeSeq : since;
    await this.cursors.set(actor.id, entity, cursor);

    return { entity, items, cursor, hasMore, protocol: SYNC_PROTOCOL_VERSION };
  }

  async status(actor: User): Promise<SyncStatusEntry[]> {
    const entries: SyncStatusEntry[] = [];
    for (const entity of this.registry.list()) {
      entries.push({
        entity,
        serverMaxVersion: await this.versions.maxChangeSeq(entity, actor.id),
        cursor: await this.cursors.get(actor.id, entity)
      });
    }
    return entries;
  }
}
