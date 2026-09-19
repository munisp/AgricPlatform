import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import type { KycTier, LanguageCode, User, UserRole } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { GUARDIAN_LINK_REPOSITORY, USER_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  GuardianLink,
  GuardianLinkRepository
} from '../../database/repositories/guardian-link.repository.js';
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

/**
 * Assisted/shared-phone onboarding (V-44, dim04-H2): a phoneless farmer or a
 * household sharing one SIM gets a DISTINCT identity whose contact phone is
 * the guardian's (or custodian agent's) — stored on the guardian link, NOT
 * on identity.users.phone, which stays globally unique for self-service
 * accounts (the assisted row carries a synthetic `assisted:<id>` phone).
 */
export interface CreateAssistedAccountInput {
  fullName: string;
  preferredLanguage: LanguageCode;
  roles?: UserRole[];
  /** Shared contact phone; defaults to the guardian's/agent's own phone. */
  contactPhone?: string;
  /** Household guardian account — XOR custodianAgentId. */
  guardianUserId?: string;
  /** Custodian agent (must carry the 'agent' role) — XOR guardianUserId. */
  custodianAgentId?: string;
  relationship: string;
  /** Presence proof: the guardian/agent physically attested the dependent. */
  presenceProof: { method: string; ref: string };
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
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    // V-44: guardian links for assisted accounts. Optional so bare unit-test
    // constructions keep working — assisted onboarding fails closed without it.
    @Optional()
    @Inject(GUARDIAN_LINK_REPOSITORY)
    private readonly guardianLinks?: GuardianLinkRepository
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

  /**
   * OB-05: adds a role without disturbing the existing ones; a no-op when
   * the user already holds it (safe for idempotent activation replays).
   */
  async grantRole(id: string, role: UserRole): Promise<User> {
    const user = await this.repo.getById(id);
    if (user.roles.includes(role)) {
      return user;
    }
    return this.repo.update(id, { roles: [...user.roles, role] });
  }

  /**
   * Assisted/shared-phone onboarding (V-44). Fail closed on every gate:
   * repository wired, caller authenticated AND being the guardian/agent
   * themselves (presence), guardian/agent account active, presence proof
   * attached. Two farmers can share one contact phone this way while each
   * keeps a distinct identity (login/transactions route via the guardian or
   * agent channel — assisted rows cannot self-authenticate by phone OTP).
   */
  async createAssisted(
    input: CreateAssistedAccountInput,
    actor: User | null
  ): Promise<{ user: User; link: GuardianLink }> {
    if (!this.guardianLinks) {
      throw new ServiceUnavailableException(
        'Assisted-account onboarding is unavailable: guardian-link store not wired'
      );
    }
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    if (!input.fullName?.trim() || !input.relationship?.trim()) {
      throw new BadRequestException('fullName and relationship are required');
    }
    if (!input.presenceProof?.method?.trim() || !input.presenceProof?.ref?.trim()) {
      // Presence proof is the anti-ghost-account control: without it a
      // guardian/agent could mint untraceable shadow identities.
      throw new BadRequestException('presenceProof { method, ref } is required');
    }
    const hasGuardian = !!input.guardianUserId;
    const hasAgent = !!input.custodianAgentId;
    if (hasGuardian === hasAgent) {
      throw new BadRequestException(
        'Exactly one of guardianUserId or custodianAgentId is required'
      );
    }
    const custodianId = input.guardianUserId ?? input.custodianAgentId!;
    const isAdmin = actor.roles.includes('admin');
    if (actor.id !== custodianId && !isAdmin) {
      // Presence: the guardian/agent performs the onboarding in person.
      throw new ForbiddenException(
        'Only the guardian/custodian agent themselves (or an admin) may onboard an assisted account'
      );
    }
    const custodian = await this.repo.findById(custodianId);
    if (!custodian) {
      throw new NotFoundException('Guardian/custodian account does not exist');
    }
    if ((await this.statusFor(custodianId)) !== 'active') {
      throw new ConflictException('Guardian/custodian account is not active');
    }
    if (hasAgent && !custodian.roles.includes('agent')) {
      throw new ForbiddenException('Custodian must carry the agent role');
    }
    const contactPhone = (input.contactPhone ?? custodian.phone).trim();
    if (!contactPhone) {
      throw new BadRequestException('A contact phone is required');
    }
    const id = newId('user');
    const user: User = {
      id,
      // Synthetic internal phone keeps the global-unique invariant; the real
      // shared contact phone lives on the guardian link.
      phone: `assisted:${id}`,
      fullName: input.fullName.trim(),
      roles: input.roles ?? ['farmer'],
      preferredLanguage: input.preferredLanguage,
      kycTier: 'tier_0',
      isVerified: false,
      createdAt: new Date().toISOString()
    };
    // OB-04: the user row and the guardian/custody link commit atomically
    // (single transaction on the pg driver; compensated in-memory) — a
    // link-write failure must not leave an orphaned assisted identity.
    return this.repo.createWithGuardianLink(user, {
      id: newId('guardianlink'),
      dependentUserId: id,
      guardianUserId: hasGuardian ? custodianId : undefined,
      custodianAgentId: hasAgent ? custodianId : undefined,
      kind: hasGuardian ? 'guardian' : 'agent_custody',
      relationship: input.relationship.trim(),
      contactPhone,
      presenceProof: {
        method: input.presenceProof.method.trim(),
        ref: input.presenceProof.ref.trim(),
        attestedAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString()
    });
  }

  /** Guardian/custody links for a dependent (V-44). */
  async guardianLinksFor(dependentUserId: string): Promise<GuardianLink[]> {
    if (!this.guardianLinks) {
      return [];
    }
    return this.guardianLinks.find({ dependentUserId });
  }

  /** Dependents under a guardian or custodian agent (V-44). */
  async dependentsOf(custodianUserId: string): Promise<GuardianLink[]> {
    if (!this.guardianLinks) {
      return [];
    }
    const asGuardian = await this.guardianLinks.find({ guardianUserId: custodianUserId });
    const asAgent = await this.guardianLinks.find({ custodianAgentId: custodianUserId });
    return [...asGuardian, ...asAgent];
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
