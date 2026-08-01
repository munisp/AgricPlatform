import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { KycTier, LanguageCode, User, UserRole } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { USER_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  AccountStatus,
  UserCriteria,
  UserRepository
} from '../../database/repositories/user.repository.js';
import type { ApiListResponse } from '@agric-platform/shared';

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
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository
  ) {}

  async list(
    filter: UserCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<User>> {
    return this.repo.searchPage({ role: filter.role, q: filter.q }, filter.page, filter.pageSize);
  }

  async findById(id: string): Promise<User | undefined> {
    return this.repo.findById(id);
  }

  async getById(id: string): Promise<User> {
    return this.repo.getById(id);
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    return this.repo.findByPhone(phone);
  }

  async create(input: CreateUserInput): Promise<User> {
    if (await this.findByPhone(input.phone)) {
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

  async update(id: string, patch: UpdateUserInput): Promise<User> {
    return this.repo.update(id, { ...patch, lastActiveAt: new Date().toISOString() });
  }

  async setRoles(id: string, roles: UserRole[]): Promise<User> {
    return this.repo.update(id, { roles });
  }

  async setVerified(id: string, isVerified: boolean): Promise<User> {
    return this.repo.update(id, { isVerified });
  }

  /** NDPR deletion: irreversibly masks personally identifiable fields. */
  async anonymize(id: string): Promise<User> {
    return this.repo.update(id, {
      phone: `deleted:${id}`,
      email: undefined,
      fullName: 'Deleted user',
      lastActiveAt: new Date().toISOString()
    });
  }

  async setStatus(userId: string, status: AccountStatus): Promise<void> {
    return this.repo.setStatus(userId, status);
  }

  async statusFor(userId: string): Promise<AccountStatus> {
    return this.repo.statusFor(userId);
  }

  async countByRole(role: UserRole): Promise<number> {
    return this.repo.countByRole(role);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }
}
