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
  AUTH_SESSION_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  LOAN_APPLICATION_REPOSITORY,
  SUCCESSION_CLAIM_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY,
  WAREHOUSE_TRANSFER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import type { CreditSavingsAccountRepository } from '../../database/repositories/credit-suite.repository.js';
import type { LoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import type {
  SuccessionClaim,
  SuccessionClaimRepository
} from '../../database/repositories/succession.repository.js';
import type {
  WarehouseReceiptRepository,
  WarehouseTransferRepository
} from '../../database/repositories/warehouse.repository.js';
import { UsersService } from '../users/users.service.js';

/** Estate-scoped asset overview for a deceased account (V-09). */
export interface EstateOverview {
  userId: string;
  accountStatus: string;
  loans: Array<{ id: string; status: string; amountKobo?: number }>;
  receipts: Array<{ id: string; receiptNumber: string; status: string; crop: string }>;
  savingsAccounts: Array<{ id: string; balanceKobo: number }>;
  /** Wallet/VSLA share value, kobo. */
  totalSavingsKobo: number;
  claims: SuccessionClaim[];
}

/**
 * Deceased/succession flow (V-09, dim04-H1). DISTINCT from DSAR erasure:
 * UsersService.anonymize() severs the estate linkage (phone →
 * `deleted:<id>`), which would orphan loans, receipts, VSLA shares and the
 * wallet — so a deceased account is NEVER anonymised. Instead it carries
 * the `deceased` account status: sessions are revoked, withdrawals refuse
 * (credit/savings.service.ts), and the identity row survives until an
 * approved next-of-kin claim transfers the estate.
 *
 * Flow: admin marks deceased (evidence required) → next-of-kin files a
 * claim (evidence required, fail closed on living accounts) → admin
 * approves → receipts transfer to the heir with append-only transfer
 * records + audit, personal savings (VSLA shares/wallet) are re-assigned,
 * loans stay listed as estate liabilities (settled from the estate, never
 * silently re-pointed — recorded in the audit note).
 */
@Injectable()
export class SuccessionService {
  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Optional() private readonly audit: AuditService | undefined,
    @Inject(SUCCESSION_CLAIM_REPOSITORY)
    private readonly claims: SuccessionClaimRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(WAREHOUSE_RECEIPT_REPOSITORY) private readonly receipts: WarehouseReceiptRepository,
    @Inject(WAREHOUSE_TRANSFER_REPOSITORY) private readonly transfers: WarehouseTransferRepository,
    @Inject(LOAN_APPLICATION_REPOSITORY) private readonly loans: LoanApplicationRepository,
    @Inject(CREDIT_SAVINGS_ACCOUNT_REPOSITORY)
    private readonly savings: CreditSavingsAccountRepository
  ) {}

  /**
   * Marks an account deceased (admin, evidence required). Idempotent.
   * Revokes every session and freezes the estate; never anonymises.
   */
  async markDeceased(userId: string, actor: User | null, evidenceRef: string): Promise<void> {
    const admin = requireAdmin(actor);
    if (!evidenceRef?.trim()) {
      throw new BadRequestException('evidenceRef is required (death certificate reference)');
    }
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException(`User '${userId}' does not exist`);
    }
    if ((await this.users.statusFor(userId)) === 'deceased') {
      return; // idempotent
    }
    await this.users.setStatus(userId, 'deceased');
    const revoked = await this.sessions.revokeAllForUser(userId, new Date().toISOString());
    await this.audit?.record({
      actorId: admin.id,
      action: 'succession.deceased_marked',
      entityType: 'user',
      entityId: userId,
      metadata: { evidenceRef: evidenceRef.trim(), sessionsRevoked: revoked }
    });
    await this.events.publish('succession.estate.marked_deceased', { userId }, admin.id);
  }

  /** Files a next-of-kin claim. Fail closed: the account must be deceased. */
  async fileClaim(
    deceasedUserId: string,
    input: {
      claimantName: string;
      claimantPhone?: string;
      heirUserId?: string;
      relationship: string;
      evidenceRef: string;
    },
    actor: User | null
  ): Promise<SuccessionClaim> {
    const caller = requireUser(actor);
    if ((await this.users.statusFor(deceasedUserId).catch(() => 'active')) !== 'deceased') {
      // Never confirm the account exists/is alive in the error text.
      throw new ConflictException('No deceased estate is open for claims on this account');
    }
    if (!input.claimantName?.trim() || !input.relationship?.trim() || !input.evidenceRef?.trim()) {
      throw new BadRequestException('claimantName, relationship and evidenceRef are required');
    }
    if (input.heirUserId) {
      const heir = await this.users.findById(input.heirUserId);
      if (!heir) {
        throw new BadRequestException(`Heir account '${input.heirUserId}' does not exist`);
      }
      if ((await this.users.statusFor(heir.id)) !== 'active') {
        throw new ConflictException('The heir account is not active');
      }
    }
    const open = await this.claims.find({ deceasedUserId, status: 'pending' });
    if (open.length > 0) {
      throw new ConflictException('A succession claim is already pending for this estate');
    }
    const claim: SuccessionClaim = {
      id: newId('succession'),
      deceasedUserId,
      heirUserId: input.heirUserId,
      claimantName: input.claimantName.trim(),
      claimantPhone: input.claimantPhone?.trim() || undefined,
      relationship: input.relationship.trim(),
      evidenceRef: input.evidenceRef.trim(),
      status: 'pending',
      filedAt: new Date().toISOString()
    };
    const saved = await this.claims.create(claim);
    await this.audit?.record({
      actorId: caller.id,
      action: 'succession.claim_filed',
      entityType: 'succession_claim',
      entityId: saved.id,
      metadata: { deceasedUserId, relationship: saved.relationship }
    });
    return saved;
  }

  /** Estate-scoped read: admin, or the heir named on a claim for this estate. */
  async estateOverview(deceasedUserId: string, actor: User | null): Promise<EstateOverview> {
    const caller = requireUser(actor);
    const isAdmin = caller.roles.includes('admin');
    const relatedClaim = await this.claims.find({ deceasedUserId, heirUserId: caller.id });
    if (!isAdmin && relatedClaim.length === 0) {
      throw new ForbiddenException('Only an admin or a claimant heir may read this estate');
    }
    const [loans, receipts, savings, claims] = await Promise.all([
      this.loans.find({ applicantId: deceasedUserId }),
      this.receipts.find({ ownerId: deceasedUserId }),
      this.savings.find({ userId: deceasedUserId }),
      this.claims.find({ deceasedUserId })
    ]);
    return {
      userId: deceasedUserId,
      accountStatus: await this.users.statusFor(deceasedUserId),
      loans: loans.map((loan) => ({
        id: loan.id,
        status: loan.status,
        amountKobo: (loan as { amountKobo?: number }).amountKobo
      })),
      receipts: receipts.map((receipt) => ({
        id: receipt.id,
        receiptNumber: receipt.receiptNumber,
        status: receipt.status,
        crop: receipt.crop
      })),
      savingsAccounts: savings.map((account) => ({ id: account.id, balanceKobo: account.balanceKobo })),
      totalSavingsKobo: savings.reduce((total, account) => total + account.balanceKobo, 0),
      claims
    };
  }

  /**
   * Approves a pending claim (admin) and transfers the estate to the heir:
   * receipts change ownership via CAS with append-only transfer records,
   * personal savings accounts (VSLA shares/wallet) are re-assigned. Loans
   * remain liabilities of the estate and are NOT re-pointed (audit note).
   */
  async approveClaim(
    claimId: string,
    actor: User | null,
    decision?: { heirUserId?: string; note?: string }
  ): Promise<{ claim: SuccessionClaim; receiptsTransferred: number; savingsTransferred: number }> {
    const admin = requireAdmin(actor);
    const claim = await this.claims.getById(claimId);
    if (claim.status !== 'pending') {
      throw new ConflictException(`Claim ${claimId} is already ${claim.status}`);
    }
    const heirUserId = decision?.heirUserId ?? claim.heirUserId;
    if (!heirUserId) {
      throw new BadRequestException('heirUserId is required at approval when the claim has none');
    }
    const heir = await this.users.findById(heirUserId);
    if (!heir) {
      throw new BadRequestException(`Heir account '${heirUserId}' does not exist`);
    }
    if ((await this.users.statusFor(heirUserId)) !== 'active') {
      throw new ConflictException('The heir account is not active');
    }
    if ((await this.users.statusFor(claim.deceasedUserId)) !== 'deceased') {
      throw new ConflictException('The estate account is not deceased');
    }

    const now = new Date().toISOString();
    // Receipts: pledged/redeemed receipts stay put (lien/settled); the rest
    // transfer with claim-first CAS + an append-only transfer record.
    const receipts = await this.receipts.find({ ownerId: claim.deceasedUserId });
    let receiptsTransferred = 0;
    for (const receipt of receipts) {
      if (receipt.status !== 'active') {
        continue;
      }
      const event = this.events.build(
        'warehouse.receipt.transferred',
        {
          receiptId: receipt.id,
          fromOwnerId: receipt.ownerId,
          toOwnerId: heirUserId,
          successionClaimId: claim.id
        },
        admin.id
      );
      await this.receipts.updateExpected(
        receipt.id,
        { ownerId: heirUserId, updatedAt: now },
        { ownerId: claim.deceasedUserId, status: receipt.status },
        event
      );
      await this.transfers.create({
        id: newId('whtransfer'),
        receiptId: receipt.id,
        fromOwnerId: claim.deceasedUserId,
        toOwnerId: heirUserId,
        transferredBy: admin.id,
        note: `Succession claim ${claim.id} (${claim.relationship})`,
        createdAt: now
      });
      receiptsTransferred += 1;
    }

    // VSLA shares / wallet: personal savings accounts re-assigned to the heir.
    const savingsAccounts = await this.savings.find({ userId: claim.deceasedUserId });
    let savingsTransferred = 0;
    for (const account of savingsAccounts) {
      await this.savings.updateExpected(
        account.id,
        { userId: heirUserId, updatedAt: now },
        { userId: claim.deceasedUserId }
      );
      savingsTransferred += 1;
    }

    const decided = await this.claims.update(claim.id, {
      status: 'approved',
      heirUserId,
      decidedAt: now,
      decidedBy: admin.id,
      decisionNote: decision?.note?.trim() || undefined
    });
    await this.audit?.record({
      actorId: admin.id,
      action: 'succession.claim_approved',
      entityType: 'succession_claim',
      entityId: claim.id,
      metadata: {
        deceasedUserId: claim.deceasedUserId,
        heirUserId,
        receiptsTransferred,
        savingsTransferred,
        // Loans are intentionally NOT re-pointed: they are liabilities the
        // estate settles; re-assignment would silently move debt.
        loansLeftWithEstate: (await this.loans.find({ applicantId: claim.deceasedUserId })).length
      }
    });
    await this.events.publish(
      'succession.estate.transferred',
      {
        claimId: claim.id,
        deceasedUserId: claim.deceasedUserId,
        heirUserId,
        receiptsTransferred,
        savingsTransferred
      },
      admin.id
    );
    return { claim: decided, receiptsTransferred, savingsTransferred };
  }

  /** Rejects a pending claim (admin) with a reason; the estate stays frozen. */
  async rejectClaim(claimId: string, actor: User | null, note: string): Promise<SuccessionClaim> {
    const admin = requireAdmin(actor);
    const claim = await this.claims.getById(claimId);
    if (claim.status !== 'pending') {
      throw new ConflictException(`Claim ${claimId} is already ${claim.status}`);
    }
    if (!note?.trim()) {
      throw new BadRequestException('A rejection note is required');
    }
    const decided = await this.claims.update(claim.id, {
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: admin.id,
      decisionNote: note.trim()
    });
    await this.audit?.record({
      actorId: admin.id,
      action: 'succession.claim_rejected',
      entityType: 'succession_claim',
      entityId: claim.id,
      metadata: { deceasedUserId: claim.deceasedUserId, note: note.trim() }
    });
    return decided;
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
