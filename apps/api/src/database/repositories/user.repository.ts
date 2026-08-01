import type { ApiListResponse, User, UserRole } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { ilike, InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedUsers } from '../seed-data.js';

/** Admin-managed account overlay; backed by identity.users.status in pg. */
export type AccountStatus = 'active' | 'suspended';

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

  constructor(seed: readonly User[] = []) {
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
}

export function createInMemoryUserRepository(): InMemoryUserRepository {
  return new InMemoryUserRepository(seedUsers);
}
