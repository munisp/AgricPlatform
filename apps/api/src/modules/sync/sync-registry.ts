import { ConflictException, Injectable } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import type { SyncPushItem } from './sync.types.js';

/**
 * SyncableEntityRegistry (Wave SYNCSRV): modules opt their entities into the
 * sync protocol by registering a descriptor. The sync module itself performs
 * no entity-specific I/O — every read/apply goes through the descriptor, so
 * adding an entity (e.g. the farms wave) is: build a descriptor over that
 * module's repository and call `registry.register(...)` from that module.
 *
 * v1 ships two read-only proof entities (marketplace_listing, notification)
 * registered by sync-proof-entities.ts. Read-only means the server is the
 * only writer: pulls work, pushes are rejected per item with
 * `read_only_entity`.
 */
export interface SyncableEntityDescriptor {
  /** Protocol entity key, e.g. 'marketplace_listing' (snake_case). */
  readonly name: string;
  /** Name of the owner field on the source record (documentation/errors). */
  readonly ownerField: string;
  /** Whether clients may push mutations for this entity. */
  readonly writable: boolean;
  /**
   * Owner id used for scope checks, or null when the record does not exist.
   * For upserts of NEW records the caller becomes the owner.
   */
  getOwnerId(entityId: string): Promise<string | null>;
  /**
   * Current payloads for the given ids (pull materialisation). Ids without a
   * live record are simply absent from the map — the pull path serves them
   * as tombstones.
   */
  getPayloads(entityIds: readonly string[]): Promise<Map<string, unknown>>;
  /**
   * Writable entities only: apply one validated push item. Implementations
   * MUST advance sync.entity_versions atomically with the entity write
   * (EntityVersionRepository.bumpExpected) and return the new version.
   */
  apply?(actor: User, item: SyncPushItem): Promise<number>;
}

@Injectable()
export class SyncEntityRegistry {
  private readonly entities = new Map<string, SyncableEntityDescriptor>();

  /** Fail-closed: duplicate names are a wiring bug and abort registration. */
  register(descriptor: SyncableEntityDescriptor): void {
    if (this.entities.has(descriptor.name)) {
      throw new ConflictException(`Sync entity '${descriptor.name}' is already registered`);
    }
    this.entities.set(descriptor.name, descriptor);
  }

  get(name: string): SyncableEntityDescriptor | undefined {
    return this.entities.get(name);
  }

  /** Registered entity names, stable-sorted (status endpoint, diagnostics). */
  list(): string[] {
    return [...this.entities.keys()].sort();
  }
}
