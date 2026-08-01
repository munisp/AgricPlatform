import { ConflictException, Injectable } from '@nestjs/common';
import type { KycTier, LanguageCode, User, UserRole } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
import type { ApiListResponse } from '@agric-platform/shared';
import { seedUsers } from '../../database/seed-data.js';

export interface CreateUserInput {
  phone: string;
  email?: string;
  fullName: string;
  roles: UserRole[];
  preferredLanguage: LanguageCode;
}

export interface UpdateUserInput {
  fullName?: string;
  email?: string;
  preferredLanguage?: LanguageCode;
  kycTier?: KycTier;
}

@Injectable()
export class UsersService {
  private readonly repo = new InMemoryRepository<User>(seedUsers);

  list(filter: { role?: UserRole; q?: string; page?: number; pageSize?: number }): ApiListResponse<User> {
    let items = this.repo.all();
    if (filter.role) {
      items = items.filter((user) => user.roles.includes(filter.role as UserRole));
    }
    if (filter.q) {
      const q = filter.q.toLowerCase();
      items = items.filter(
        (user) => user.fullName.toLowerCase().includes(q) || user.phone.includes(q)
      );
    }
    return paginate(items, filter.page, filter.pageSize);
  }

  findById(id: string): User | undefined {
    return this.repo.findById(id);
  }

  getById(id: string): User {
    return this.repo.getById(id);
  }

  findByPhone(phone: string): User | undefined {
    return this.repo.findOne((user) => user.phone === phone);
  }

  create(input: CreateUserInput): User {
    if (this.findByPhone(input.phone)) {
      throw new ConflictException(`Phone number ${input.phone} is already registered`);
    }
    const user: User = {
      id: newId('user'),
      phone: input.phone,
      email: input.email,
      fullName: input.fullName,
      roles: input.roles,
      preferredLanguage: input.preferredLanguage,
      kycTier: 'tier_0',
      isVerified: false,
      createdAt: new Date().toISOString()
    };
    return this.repo.create(user);
  }

  update(id: string, patch: UpdateUserInput): User {
    return this.repo.update(id, { ...patch, lastActiveAt: new Date().toISOString() });
  }

  setRoles(id: string, roles: UserRole[]): User {
    return this.repo.update(id, { roles });
  }

  setVerified(id: string, isVerified: boolean): User {
    return this.repo.update(id, { isVerified });
  }

  /** NDPR deletion: irreversibly masks personally identifiable fields. */
  anonymize(id: string): User {
    return this.repo.update(id, {
      phone: `deleted:${id}`,
      email: undefined,
      fullName: 'Deleted user',
      lastActiveAt: new Date().toISOString()
    });
  }

  countByRole(role: UserRole): number {
    return this.repo.count((user) => user.roles.includes(role));
  }

  count(): number {
    return this.repo.count();
  }
}
