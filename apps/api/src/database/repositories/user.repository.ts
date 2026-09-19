import { ServiceUnavailableException } from '@nestjs/common';
import type { ApiListResponse, User, UserRole } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { ilike, InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedUsers } from '../seed-data.js';
import type { GuardianLink, GuardianLinkRepository } from './guardian-link.repository.js';

/**
 * Admin-managed account overlay; backed by identity.users.status in pg.
 * `deceased` (V-09, migration 086): estate-frozen — sessions are revoked and
 * withdrawals refuse; the identity row is NEVER anonymised (succession
 * claims need the estate linkage, unlike DSAR erasure).
 */
export type AccountStatus = 'active' | 'suspended' | 'deceased';

export interface UserCriteria {
  role?: UserRole;
  q?: string;
}

export interface UserRepository extends AsyncRepository<User, UserCriteria> {
  searchPage(
    criteria: UserCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<User>>;
  countByRole(role: UserRole): Promise<number>;
  findByPhone(phone: string): Promise<User | undefined>;
  setStatus(userId: string, status: AccountStatus): Promise<void>;
  statusFor(userId: string): Promise<AccountStatus>;
  /**
   * OB-04: assisted-account onboarding — the user row (+ role rows) and the
   * guardian/custody link as ONE atomic unit. On the pg driver both writes
   * share a single transaction, so a link-write failure rolls the user row
   * back; the in-memory implementation compensates (removes the user row) on
   * link failure. Fails closed when the guardian-link store is not wired.
   */
  createWithGuardianLink(user: User, link: GuardianLink): Promise<{ user: User; link: GuardianLink }>;
}

export function userMatcher(criteria: UserCriteria): (user: User) => boolean {
  return (user) =>
    (!criteria.role || user.roles.includes(criteria.role)) &&
    (!criteria.q || ilike(user.fullName, criteria.q) || user.phone.includes(criteria.q));
}

export class InMemoryUserRepository
  extends InMemoryRepository<User, UserCriteria>
  implements UserRepository
{
  private readonly statuses = new Map<string, AccountStatus>();

  constructor(
    seed: readonly User[] = [],
    private readonly guardianLinks?: GuardianLinkRepository
  ) {
    super(seed, userMatcher);
  }

  async countByRole(role: UserRole): Promise<number> {
    return this.count({ role });
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    return (await this.all()).find((user) => user.phone === phone);
  }

  async setStatus(userId: string, status: AccountStatus): Promise<void> {
    await this.getById(userId);
    this.statuses.set(userId, status);
  }

  async statusFor(userId: string): Promise<AccountStatus> {
    return this.statuses.get(userId) ?? 'active';
  }

  /**
   * In-memory counterpart of the pg single-transaction write: the link store
   * must be wired (fail closed otherwise) and a link-write failure compensates
   * by removing the just-created user row, so no orphaned assisted identity
   * persists.
   */
  async createWithGuardianLink(
    user: User,
    link: GuardianLink
  ): Promise<{ user: User; link: GuardianLink }> {
    if (!this.guardianLinks) {
      throw new ServiceUnavailableException(
        'Assisted-account onboarding is unavailable: guardian-link store not wired'
      );
    }
    const created = await this.create(user);
    try {
      const createdLink = await this.guardianLinks.create(link);
      return { user: created, link: createdLink };
    } catch (error) {
      await this.remove(user.id);
      throw error;
    }
  }
}

export function createInMemoryUserRepository(
  guardianLinks?: GuardianLinkRepository
): InMemoryUserRepository {
  return new InMemoryUserRepository(seedUsers, guardianLinks);
}
