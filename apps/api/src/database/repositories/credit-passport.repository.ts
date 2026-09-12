import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  CreditPassportCredential,
  CreditPassportDisclosure,
  CreditPassportStatus
} from '../../modules/credit-passport/credit-passport.types.js';

/**
 * Credit Passport persistence ports (Stage 27, Innovation 7; migration 065,
 * schema `credit_passport`). Credentials are APPEND-ONLY per farmer: new
 * versions are inserted, and the only mutable fields are the lifecycle
 * status / revokedAt (supersede + revoke transitions) — payload, hashes and
 * code material never change after insert. Disclosures expose no update
 * beyond revocation. The in-memory implementation here and the pg
 * implementation in credit-passport.pg-repository.ts must stay behaviourally
 * identical.
 */

// ---------------------------------------------------------------------------
// Credentials (credit_passport.credentials) — append-only version chain
// ---------------------------------------------------------------------------

export interface CreditPassportCredentialCriteria {
  userId?: string;
  status?: CreditPassportStatus;
}

export interface CreditPassportCredentialRepository {
  /**
   * Inserts a new credential version. Throws ConflictException when the id,
   * code, payload_hash or (userId, version) pair already exists, or when the
   * user already holds an ACTIVE credential (one active per user).
   */
  create(credential: CreditPassportCredential): Promise<CreditPassportCredential>;
  findById(id: string): Promise<CreditPassportCredential | undefined>;
  getById(id: string): Promise<CreditPassportCredential>;
  findByCode(passportCode: string): Promise<CreditPassportCredential | undefined>;
  /** The user's current chain head (status 'active'), when one exists. */
  findActiveByUserId(userId: string): Promise<CreditPassportCredential | undefined>;
  /** All versions of a farmer's chain, ascending by version. */
  listByUserId(userId: string): Promise<CreditPassportCredential[]>;
  find(criteria: CreditPassportCredentialCriteria): Promise<CreditPassportCredential[]>;
  /** Lifecycle transitions only: status / revokedAt. Payload and hashes are immutable. */
  update(
    id: string,
    patch: Partial<Pick<CreditPassportCredential, 'status' | 'revokedAt'>>
  ): Promise<CreditPassportCredential>;
}

export class InMemoryCreditPassportCredentialRepository
  implements CreditPassportCredentialRepository
{
  private readonly items = new Map<string, CreditPassportCredential>();

  constructor(seed: readonly CreditPassportCredential[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(credential: CreditPassportCredential): Promise<CreditPassportCredential> {
    if (this.items.has(credential.id)) {
      throw new ConflictException(`Credit passport credential '${credential.id}' already exists`);
    }
    for (const existing of this.items.values()) {
      if (existing.userId === credential.userId && existing.version === credential.version) {
        throw new ConflictException(
          `User '${credential.userId}' already holds credit passport version ${credential.version}`
        );
      }
      if (existing.passportCode === credential.passportCode) {
        throw new ConflictException('A credit passport with this code already exists');
      }
      if (existing.payloadHash === credential.payloadHash) {
        throw new ConflictException('A credit passport with this payload hash already exists');
      }
      if (
        credential.status === 'active' &&
        existing.userId === credential.userId &&
        existing.status === 'active'
      ) {
        throw new ConflictException(
          `User '${credential.userId}' already holds an active credit passport ('${existing.id}')`
        );
      }
    }
    this.items.set(credential.id, structuredClone(credential));
    return credential;
  }

  async findById(id: string): Promise<CreditPassportCredential | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<CreditPassportCredential> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Credit passport credential '${id}' not found`);
    }
    return item;
  }

  async findByCode(passportCode: string): Promise<CreditPassportCredential | undefined> {
    const item = [...this.items.values()].find((c) => c.passportCode === passportCode);
    return item ? structuredClone(item) : undefined;
  }

  async findActiveByUserId(userId: string): Promise<CreditPassportCredential | undefined> {
    const item = [...this.items.values()].find(
      (c) => c.userId === userId && c.status === 'active'
    );
    return item ? structuredClone(item) : undefined;
  }

  async listByUserId(userId: string): Promise<CreditPassportCredential[]> {
    return [...this.items.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => a.version - b.version)
      .map((c) => structuredClone(c));
  }

  async find(criteria: CreditPassportCredentialCriteria): Promise<CreditPassportCredential[]> {
    return [...this.items.values()]
      .filter(
        (credential) =>
          (!criteria.userId || credential.userId === criteria.userId) &&
          (!criteria.status || credential.status === criteria.status)
      )
      .map((credential) => structuredClone(credential));
  }

  async update(
    id: string,
    patch: Partial<Pick<CreditPassportCredential, 'status' | 'revokedAt'>>
  ): Promise<CreditPassportCredential> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`Credit passport credential '${id}' not found`);
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryCreditPassportCredentialRepository(
  seed: readonly CreditPassportCredential[] = []
): InMemoryCreditPassportCredentialRepository {
  return new InMemoryCreditPassportCredentialRepository(seed);
}

// ---------------------------------------------------------------------------
// Disclosures (credit_passport.disclosures) — consent-scoped, expiring
// ---------------------------------------------------------------------------

export interface CreditPassportDisclosureCriteria {
  credentialId?: string;
  userId?: string;
  disclosedTo?: string;
}

export interface CreditPassportDisclosureRepository {
  /** Throws ConflictException when the id already exists. */
  create(disclosure: CreditPassportDisclosure): Promise<CreditPassportDisclosure>;
  findById(id: string): Promise<CreditPassportDisclosure | undefined>;
  getById(id: string): Promise<CreditPassportDisclosure>;
  find(criteria: CreditPassportDisclosureCriteria): Promise<CreditPassportDisclosure[]>;
  /** Revocation only (sets revokedAt). */
  update(
    id: string,
    patch: Partial<Pick<CreditPassportDisclosure, 'revokedAt'>>
  ): Promise<CreditPassportDisclosure>;
}

export class InMemoryCreditPassportDisclosureRepository
  implements CreditPassportDisclosureRepository
{
  private readonly items = new Map<string, CreditPassportDisclosure>();

  constructor(seed: readonly CreditPassportDisclosure[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(disclosure: CreditPassportDisclosure): Promise<CreditPassportDisclosure> {
    if (this.items.has(disclosure.id)) {
      throw new ConflictException(`Credit passport disclosure '${disclosure.id}' already exists`);
    }
    this.items.set(disclosure.id, structuredClone(disclosure));
    return disclosure;
  }

  async findById(id: string): Promise<CreditPassportDisclosure | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<CreditPassportDisclosure> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Credit passport disclosure '${id}' not found`);
    }
    return item;
  }

  async find(criteria: CreditPassportDisclosureCriteria): Promise<CreditPassportDisclosure[]> {
    return [...this.items.values()]
      .filter(
        (disclosure) =>
          (!criteria.credentialId || disclosure.credentialId === criteria.credentialId) &&
          (!criteria.userId || disclosure.userId === criteria.userId) &&
          (!criteria.disclosedTo || disclosure.disclosedTo === criteria.disclosedTo)
      )
      .map((disclosure) => structuredClone(disclosure));
  }

  async update(
    id: string,
    patch: Partial<Pick<CreditPassportDisclosure, 'revokedAt'>>
  ): Promise<CreditPassportDisclosure> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`Credit passport disclosure '${id}' not found`);
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryCreditPassportDisclosureRepository(
  seed: readonly CreditPassportDisclosure[] = []
): InMemoryCreditPassportDisclosureRepository {
  return new InMemoryCreditPassportDisclosureRepository(seed);
}
