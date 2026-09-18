import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ACCOUNT_MERGE_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  LOAN_APPLICATION_REPOSITORY,
  NIN_ANCHOR_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CreditLoanRepository } from '../../database/repositories/credit-suite.repository.js';
import type { LoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import type {
  AccountMerge,
  AccountMergeRepository,
  NinAnchor,
  NinAnchorRepository
} from '../../database/repositories/nin-anchor.repository.js';
import { UsersService } from '../users/users.service.js';

/** Salted NIN hash — the cleartext NIN is never persisted (V-45). */
export function hashNin(nin: string): string {
  return createHash('sha256').update(`nin-anchor:${nin}`).digest('hex');
}

export interface DuplicateNinGroup {
  ninHash: string;
  userIds: string[];
  anchorIds: string[];
}

/**
 * Global NIN anchoring + duplicate detection + account merge (V-45).
 * Anchoring is OPTIONAL and hash-only; nin_hash is deliberately not unique
 * so cross-programme duplicates surface in the duplicate report instead of
 * being invisible (two SIMs = two "farmers" double-dipping subsidies and
 * splitting credit histories). The merge flow consolidates credit history
 * (credit loans + loan applications re-pointed to the primary via CAS),
 * suspends the duplicate and writes an append-only merge record + audit.
 */
@Injectable()
export class NinIdentityService {
  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Optional() private readonly audit: AuditService | undefined,
    @Inject(NIN_ANCHOR_REPOSITORY) private readonly anchors: NinAnchorRepository,
    @Inject(ACCOUNT_MERGE_REPOSITORY) private readonly merges: AccountMergeRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly creditLoans: CreditLoanRepository,
    @Inject(LOAN_APPLICATION_REPOSITORY) private readonly loanApplications: LoanApplicationRepository
  ) {}

  /** Anchors a NIN to an account (admin or self). One anchor per user. */
  async anchorNin(userId: string, nin: string, actor: User | null): Promise<NinAnchor> {
    const caller = requireUser(actor);
    if (caller.id !== userId && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the account owner or an admin may anchor a NIN');
    }
    if (!/^\d{11}$/.test(nin)) {
      throw new BadRequestException('NIN must be exactly 11 digits');
    }
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException(`User '${userId}' does not exist`);
    }
    if ((await this.users.statusFor(userId)) !== 'active') {
      throw new ConflictException('Only an active account may anchor a NIN');
    }
    const ninHash = hashNin(nin);
    const existing = await this.anchors.find({ userId });
    if (existing.length > 0) {
      // Idempotent re-anchor of the SAME NIN; a different NIN is a conflict.
      if (existing[0].ninHash === ninHash && existing[0].status === 'active') {
        return existing[0];
      }
      throw new ConflictException(
        'This account already anchors a different NIN; resolve duplicates via the merge flow'
      );
    }
    const anchor: NinAnchor = {
      id: newId('ninanchor'),
      userId,
      ninHash,
      status: 'active',
      anchoredAt: new Date().toISOString(),
      anchoredBy: caller.id
    };
    const saved = await this.anchors.create(anchor);
    await this.audit?.record({
      actorId: caller.id,
      action: 'identity.nin_anchored',
      entityType: 'nin_anchor',
      entityId: saved.id,
      metadata: { userId }
    });
    return saved;
  }

  /**
   * Duplicate-detection report (admin): groups of accounts anchoring the
   * same NIN hash. Read-only; merges are explicit admin actions.
   */
  async duplicateReport(actor: User | null): Promise<DuplicateNinGroup[]> {
    requireAdmin(actor);
    const byHash = new Map<string, NinAnchor[]>();
    for (const anchor of await this.anchors.find({ status: 'active' })) {
      const group = byHash.get(anchor.ninHash) ?? [];
      group.push(anchor);
      byHash.set(anchor.ninHash, group);
    }
    return [...byHash.entries()]
      .filter(([, group]) => new Set(group.map((a) => a.userId)).size > 1)
      .map(([ninHash, group]) => ({
        ninHash,
        userIds: [...new Set(group.map((a) => a.userId))].sort(),
        anchorIds: group.map((a) => a.id).sort()
      }));
  }

  /**
   * Merges a duplicate account into the primary (admin): credit loans and
   * loan applications re-point to the primary (CAS), the duplicate is
   * suspended and its anchor marked merged, and an append-only merge record
   * + audit entry are written. Deceased accounts are refused — their estates
   * go through the succession flow (V-09), never through a merge.
   */
  async mergeAccounts(
    primaryUserId: string,
    duplicateUserId: string,
    actor: User | null,
    note?: string
  ): Promise<AccountMerge> {
    const admin = requireAdmin(actor);
    if (primaryUserId === duplicateUserId) {
      throw new BadRequestException('primaryUserId and duplicateUserId must differ');
    }
    const [primary, duplicate] = await Promise.all([
      this.users.findById(primaryUserId),
      this.users.findById(duplicateUserId)
    ]);
    if (!primary || !duplicate) {
      throw new NotFoundException('Both accounts must exist');
    }
    for (const [label, id] of [
      ['primary', primaryUserId],
      ['duplicate', duplicateUserId]
    ] as const) {
      const status = await this.users.statusFor(id);
      if (status === 'deceased') {
        throw new ConflictException(
          `The ${label} account is deceased; estates go through the succession flow, not a merge`
        );
      }
      if (status !== 'active' && label === 'primary') {
        throw new ConflictException('The primary account must be active');
      }
    }
    // Duplicate anchors: same NIN is the usual evidence, but a documented
    // admin note can merge without it (manual review outcome).
    if (!note?.trim()) {
      const [primaryAnchors, duplicateAnchors] = await Promise.all([
        this.anchors.find({ userId: primaryUserId, status: 'active' }),
        this.anchors.find({ userId: duplicateUserId, status: 'active' })
      ]);
      const shared =
        primaryAnchors.length > 0 &&
        duplicateAnchors.length > 0 &&
        primaryAnchors[0].ninHash === duplicateAnchors[0].ninHash;
      if (!shared) {
        throw new BadRequestException(
          'Accounts do not share an anchored NIN; provide an admin note documenting the manual-review evidence'
        );
      }
    }

    const now = new Date().toISOString();
    // Consolidate credit history: credit-suite loans…
    const creditLoans = await this.creditLoans.find({ applicantUserId: duplicateUserId });
    for (const loan of creditLoans) {
      await this.creditLoans.updateExpected(
        loan.id,
        { applicantUserId: primaryUserId },
        { applicantUserId: duplicateUserId }
      );
    }
    // …and finance loan applications.
    const applications = await this.loanApplications.find({ applicantId: duplicateUserId });
    for (const application of applications) {
      await this.loanApplications.updateExpected(
        application.id,
        { applicantId: primaryUserId },
        { applicantId: duplicateUserId }
      );
    }
    // Fold the duplicate's anchor(s) and suspend the duplicate account.
    for (const anchor of await this.anchors.find({ userId: duplicateUserId, status: 'active' })) {
      await this.anchors.update(anchor.id, { status: 'merged' });
    }
    await this.users.setStatus(duplicateUserId, 'suspended');

    const merge: AccountMerge = {
      id: newId('accountmerge'),
      primaryUserId,
      duplicateUserId,
      creditLoansMoved: creditLoans.length,
      loanApplicationsMoved: applications.length,
      mergedAt: now,
      mergedBy: admin.id,
      note: note?.trim() || undefined
    };
    const saved = await this.merges.create(merge);
    await this.audit?.record({
      actorId: admin.id,
      action: 'identity.accounts_merged',
      entityType: 'account_merge',
      entityId: saved.id,
      metadata: {
        primaryUserId,
        duplicateUserId,
        creditLoansMoved: saved.creditLoansMoved,
        loanApplicationsMoved: saved.loanApplicationsMoved
      }
    });
    await this.events.publish(
      'identity.accounts.merged',
      { primaryUserId, duplicateUserId, mergeId: saved.id },
      admin.id
    );
    return saved;
  }
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

function requireAdmin(actor: User | null): User {
  const user = requireUser(actor);
  if (!user.roles.includes('admin')) {
    throw new ForbiddenException('Administrator role required');
  }
  return user;
}
