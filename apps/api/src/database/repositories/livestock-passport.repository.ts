import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  LivestockPassport,
  PassportEvent,
  PassportStatus,
  PassportTransfer,
  PassportTransferStatus
} from '../../modules/livestock-passport/passport.types.js';

/**
 * Digital livestock passport persistence ports (wave-livestock-passport,
 * migration 036, schema `livestock_passport`). Passport events are
 * APPEND-ONLY: the port exposes no update/remove — app-level append-only
 * plus the sha256 hash chain is the integrity mechanism (DB triggers are
 * intentionally avoided; see docs/livestock-passport.md). The in-memory
 * implementation here and the pg implementation in
 * livestock-passport.pg-repository.ts must stay behaviourally identical.
 */

// ---------------------------------------------------------------------------
// Passports (livestock_passport.passports)
// ---------------------------------------------------------------------------

export interface LivestockPassportCriteria {
  ownerUserId?: string;
  animalId?: string;
  status?: PassportStatus;
}

export interface LivestockPassportRepository {
  /** Throws ConflictException when the id, animal or code is already registered. */
  create(passport: LivestockPassport): Promise<LivestockPassport>;
  findById(id: string): Promise<LivestockPassport | undefined>;
  getById(id: string): Promise<LivestockPassport>;
  findByCode(passportCode: string): Promise<LivestockPassport | undefined>;
  findByAnimalId(animalId: string): Promise<LivestockPassport | undefined>;
  find(criteria: LivestockPassportCriteria): Promise<LivestockPassport[]>;
  /** Mutable fields only: status/ownerUserId/tagCheckBasis/tagCheckDetail/updatedAt. */
  update(
    id: string,
    patch: Partial<
      Pick<LivestockPassport, 'status' | 'ownerUserId' | 'tagCheckBasis' | 'tagCheckDetail' | 'updatedAt'>
    >
  ): Promise<LivestockPassport>;
}

export class InMemoryLivestockPassportRepository implements LivestockPassportRepository {
  private readonly items = new Map<string, LivestockPassport>();

  constructor(seed: readonly LivestockPassport[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(passport: LivestockPassport): Promise<LivestockPassport> {
    if (this.items.has(passport.id)) {
      throw new ConflictException(`Livestock passport '${passport.id}' already exists`);
    }
    for (const existing of this.items.values()) {
      if (existing.animalId === passport.animalId) {
        throw new ConflictException(
          `Animal '${passport.animalId}' already has a livestock passport ('${existing.id}')`
        );
      }
      if (existing.passportCode === passport.passportCode) {
        throw new ConflictException('A livestock passport with this code already exists');
      }
    }
    this.items.set(passport.id, structuredClone(passport));
    return passport;
  }

  async findById(id: string): Promise<LivestockPassport | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<LivestockPassport> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Livestock passport '${id}' not found`);
    }
    return item;
  }

  async findByCode(passportCode: string): Promise<LivestockPassport | undefined> {
    const item = [...this.items.values()].find((p) => p.passportCode === passportCode);
    return item ? structuredClone(item) : undefined;
  }

  async findByAnimalId(animalId: string): Promise<LivestockPassport | undefined> {
    const item = [...this.items.values()].find((p) => p.animalId === animalId);
    return item ? structuredClone(item) : undefined;
  }

  async find(criteria: LivestockPassportCriteria): Promise<LivestockPassport[]> {
    return [...this.items.values()]
      .filter(
        (passport) =>
          (!criteria.ownerUserId || passport.ownerUserId === criteria.ownerUserId) &&
          (!criteria.animalId || passport.animalId === criteria.animalId) &&
          (!criteria.status || passport.status === criteria.status)
      )
      .map((passport) => structuredClone(passport));
  }

  async update(
    id: string,
    patch: Partial<
      Pick<LivestockPassport, 'status' | 'ownerUserId' | 'tagCheckBasis' | 'tagCheckDetail' | 'updatedAt'>
    >
  ): Promise<LivestockPassport> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`Livestock passport '${id}' not found`);
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryLivestockPassportRepository(
  seed: readonly LivestockPassport[] = []
): InMemoryLivestockPassportRepository {
  return new InMemoryLivestockPassportRepository(seed);
}

// ---------------------------------------------------------------------------
// Passport events (livestock_passport.passport_events) — APPEND-ONLY
// ---------------------------------------------------------------------------

export interface PassportEventRepository {
  /**
   * Appends an event. Throws ConflictException when the event_hash or the
   * (passport_id, seq) pair already exists — a rewritten history collides here.
   */
  append(event: PassportEvent): Promise<PassportEvent>;
  findById(id: string): Promise<PassportEvent | undefined>;
  /** Events of one passport in chain order (ascending seq). */
  listByPassport(passportId: string): Promise<PassportEvent[]>;
  /** Current chain length for a passport (next seq). */
  countByPassport(passportId: string): Promise<number>;
}

export class InMemoryPassportEventRepository implements PassportEventRepository {
  private readonly items = new Map<string, PassportEvent>();

  constructor(seed: readonly PassportEvent[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async append(event: PassportEvent): Promise<PassportEvent> {
    for (const existing of this.items.values()) {
      if (existing.eventHash === event.eventHash) {
        throw new ConflictException('A passport event with this event_hash already exists');
      }
      if (existing.passportId === event.passportId && existing.seq === event.seq) {
        throw new ConflictException(
          `Passport event seq ${event.seq} already exists for passport '${event.passportId}'`
        );
      }
    }
    this.items.set(event.id, structuredClone(event));
    return event;
  }

  async findById(id: string): Promise<PassportEvent | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async listByPassport(passportId: string): Promise<PassportEvent[]> {
    return [...this.items.values()]
      .filter((event) => event.passportId === passportId)
      .sort((a, b) => a.seq - b.seq)
      .map((event) => structuredClone(event));
  }

  async countByPassport(passportId: string): Promise<number> {
    return [...this.items.values()].filter((event) => event.passportId === passportId).length;
  }
}

export function createInMemoryPassportEventRepository(
  seed: readonly PassportEvent[] = []
): InMemoryPassportEventRepository {
  return new InMemoryPassportEventRepository(seed);
}

// ---------------------------------------------------------------------------
// Passport transfers (livestock_passport.passport_transfers)
// ---------------------------------------------------------------------------

export interface PassportTransferCriteria {
  passportId?: string;
  fromUserId?: string;
  toUserId?: string;
  status?: PassportTransferStatus;
}

export interface PassportTransferRepository {
  /** Throws ConflictException when a pending transfer already exists for the passport. */
  create(transfer: PassportTransfer): Promise<PassportTransfer>;
  findById(id: string): Promise<PassportTransfer | undefined>;
  getById(id: string): Promise<PassportTransfer>;
  find(criteria: PassportTransferCriteria): Promise<PassportTransfer[]>;
  findPendingForPassport(passportId: string): Promise<PassportTransfer | undefined>;
  /** Status transitions + confirmation bookkeeping only. */
  update(
    id: string,
    patch: Partial<
      Pick<
        PassportTransfer,
        'status' | 'executedTransferId' | 'confirmedAt' | 'cancelledAt' | 'updatedAt'
      >
    >
  ): Promise<PassportTransfer>;
}

export class InMemoryPassportTransferRepository implements PassportTransferRepository {
  private readonly items = new Map<string, PassportTransfer>();

  constructor(seed: readonly PassportTransfer[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(transfer: PassportTransfer): Promise<PassportTransfer> {
    if (this.items.has(transfer.id)) {
      throw new ConflictException(`Passport transfer '${transfer.id}' already exists`);
    }
    if (transfer.status === 'pending' && (await this.findPendingForPassport(transfer.passportId))) {
      throw new ConflictException(
        `Passport '${transfer.passportId}' already has a pending ownership transfer`
      );
    }
    this.items.set(transfer.id, structuredClone(transfer));
    return transfer;
  }

  async findById(id: string): Promise<PassportTransfer | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<PassportTransfer> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Passport transfer '${id}' not found`);
    }
    return item;
  }

  async find(criteria: PassportTransferCriteria): Promise<PassportTransfer[]> {
    return [...this.items.values()]
      .filter(
        (transfer) =>
          (!criteria.passportId || transfer.passportId === criteria.passportId) &&
          (!criteria.fromUserId || transfer.fromUserId === criteria.fromUserId) &&
          (!criteria.toUserId || transfer.toUserId === criteria.toUserId) &&
          (!criteria.status || transfer.status === criteria.status)
      )
      .map((transfer) => structuredClone(transfer));
  }

  async findPendingForPassport(passportId: string): Promise<PassportTransfer | undefined> {
    const item = [...this.items.values()].find(
      (transfer) => transfer.passportId === passportId && transfer.status === 'pending'
    );
    return item ? structuredClone(item) : undefined;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        PassportTransfer,
        'status' | 'executedTransferId' | 'confirmedAt' | 'cancelledAt' | 'updatedAt'
      >
    >
  ): Promise<PassportTransfer> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`Passport transfer '${id}' not found`);
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryPassportTransferRepository(
  seed: readonly PassportTransfer[] = []
): InMemoryPassportTransferRepository {
  return new InMemoryPassportTransferRepository(seed);
}
