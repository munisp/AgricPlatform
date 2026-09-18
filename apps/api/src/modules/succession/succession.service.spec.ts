import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { User, WarehouseReceipt } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryCreditSavingsAccountRepository } from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryLoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemorySuccessionClaimRepository } from '../../database/repositories/succession.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import {
  createInMemoryWarehouseReceiptRepository,
  createInMemoryWarehouseTransferRepository
} from '../../database/repositories/warehouse.repository.js';
import { SessionService } from '../auth/session.service.js';
import { CreditSavingsService } from '../credit/savings.service.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { UsersService } from '../users/users.service.js';
import {
  createInMemoryCreditGroupRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditSavingsTransactionRepository
} from '../../database/repositories/credit-suite.repository.js';
import { SuccessionService } from './succession.service.js';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const sessionRepo = createInMemoryAuthSessionRepository();
  const sessions = new SessionService(users, sessionRepo);
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const audit = { record: vi.fn(async (input: unknown) => input) };
  const claims = createInMemorySuccessionClaimRepository();
  const receipts = createInMemoryWarehouseReceiptRepository();
  const transfers = createInMemoryWarehouseTransferRepository();
  const loans = createInMemoryLoanApplicationRepository();
  const savingsAccounts = createInMemoryCreditSavingsAccountRepository();
  const service = new SuccessionService(
    users,
    events,
    audit as never,
    claims,
    sessionRepo,
    receipts,
    transfers,
    loans,
    savingsAccounts
  );
  const savingsService = new CreditSavingsService(
    events,
    savingsAccounts,
    createInMemoryCreditSavingsTransactionRepository(),
    createInMemoryCreditGroupRepository(),
    createInMemoryCreditGroupMemberRepository(),
    new LedgerService(
      events,
      createInMemoryLedgerAccountRepository(),
      createInMemoryLedgerEntryRepository()
    ),
    undefined,
    users
  );
  return {
    service,
    users,
    sessions,
    sessionRepo,
    audit,
    claims,
    receipts,
    transfers,
    loans,
    savingsAccounts,
    savingsService
  };
}

async function makeUser(users: UsersService, phone: string, roles: User['roles'] = ['farmer']) {
  return users.create({ phone, fullName: 'Estate User', roles, preferredLanguage: 'en' });
}

function receipt(id: string, ownerId: string, status: WarehouseReceipt['status'] = 'active') {
  return {
    id,
    receiptNumber: `WHR-2026-${id.toUpperCase()}`,
    depositId: `dep-${id}`,
    warehouseId: 'wh-1',
    ownerId,
    crop: 'maize',
    grade: 'A' as const,
    bagCount: 10,
    weightKg: 1000,
    status,
    nonce: 'n',
    signature: 's',
    issuedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('SuccessionService (V-09)', () => {
  it('markDeceased freezes the account: sessions revoked, status deceased, never anonymised', async () => {
    const { service, users, sessionRepo, sessions, audit } = build();
    const admin = await makeUser(users, '+2349001', ['admin']);
    const farmer = await makeUser(users, '+2349002');
    await sessions.issue(farmer.id, {});
    expect((await sessionRepo.listForUser(farmer.id)).some((s) => !s.revokedAt)).toBe(true);

    await service.markDeceased(farmer.id, admin, 'death-cert-LAG-2026-001');

    expect(await users.statusFor(farmer.id)).toBe('deceased');
    expect((await sessionRepo.listForUser(farmer.id)).every((s) => s.revokedAt)).toBe(true);
    // Estate linkage preserved: NOT anonymised (contrast with DSAR erasure).
    const row = await users.getById(farmer.id);
    expect(row.phone).toBe('+2349002');
    expect(row.fullName).toBe('Estate User');
    expect(
      audit.record.mock.calls.some(
        ([input]) => (input as { action: string }).action === 'succession.deceased_marked'
      )
    ).toBe(true);
    // Idempotent second call records no error and keeps status.
    await service.markDeceased(farmer.id, admin, 'death-cert-LAG-2026-001');
    expect(await users.statusFor(farmer.id)).toBe('deceased');
  });

  it('markDeceased requires admin + evidence', async () => {
    const { service, users } = build();
    const farmer = await makeUser(users, '+2349010');
    const other = await makeUser(users, '+2349011');
    await expect(service.markDeceased(farmer.id, other, 'ev')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(service.markDeceased(farmer.id, null, 'ev')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    const admin = await makeUser(users, '+2349012', ['admin']);
    await expect(service.markDeceased(farmer.id, admin, '')).rejects.toThrowError(/evidenceRef/);
  });

  it('a deceased account freezes withdrawals but still accepts deposits', async () => {
    const { service, users, savingsService, savingsAccounts } = build();
    const admin = await makeUser(users, '+2349020', ['admin']);
    const farmer = await makeUser(users, '+2349021');
    const actor = { id: farmer.id, roles: farmer.roles };
    await savingsService.depositOwn(actor, 500_000, 'dep-1');
    await service.markDeceased(farmer.id, admin, 'evidence-1');
    await expect(savingsService.withdrawOwn(actor, 100_000, 'wd-1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    // Deposits (incoming money) still post.
    const after = await savingsService.depositOwn(actor, 100_000, 'dep-2');
    expect(after.account.balanceKobo).toBe(600_000);
    expect(savingsAccounts).toBeDefined();
  });

  it('filing a claim fails closed on living accounts and requires evidence', async () => {
    const { service, users } = build();
    const admin = await makeUser(users, '+2349030', ['admin']);
    const living = await makeUser(users, '+2349031');
    const claimant = await makeUser(users, '+2349032');
    await expect(
      service.fileClaim(
        living.id,
        { claimantName: 'Heir', relationship: 'son', evidenceRef: 'cert-1' },
        claimant
      )
    ).rejects.toBeInstanceOf(ConflictException);
    await service.markDeceased(living.id, admin, 'cert-0');
    await expect(
      service.fileClaim(
        living.id,
        { claimantName: 'Heir', relationship: '', evidenceRef: 'cert-1' },
        claimant
      )
    ).rejects.toThrowError(/required/);
  });

  it('approved heir claim transfers receipt ownership with full audit trail', async () => {
    const { service, users, receipts, transfers, savingsAccounts, audit } = build();
    const admin = await makeUser(users, '+2349040', ['admin']);
    const deceased = await makeUser(users, '+2349041');
    const heir = await makeUser(users, '+2349042');
    await receipts.create(receipt('r1', deceased.id));
    await receipts.create(receipt('r2', deceased.id));
    await receipts.create(receipt('r3', deceased.id, 'pledged')); // lien stays
    await savingsAccounts.create({
      id: 'sav-1',
      userId: deceased.id,
      balanceKobo: 250_000,
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await service.markDeceased(deceased.id, admin, 'cert-x');

    const claim = await service.fileClaim(
      deceased.id,
      {
        claimantName: 'Heir One',
        relationship: 'daughter',
        evidenceRef: 'cert-y',
        heirUserId: heir.id
      },
      heir
    );
    const outcome = await service.approveClaim(claim.id, admin);

    expect(outcome.receiptsTransferred).toBe(2);
    expect(outcome.savingsTransferred).toBe(1);
    expect((await receipts.getById('r1')).ownerId).toBe(heir.id);
    expect((await receipts.getById('r2')).ownerId).toBe(heir.id);
    // Pledged receipt keeps the lien with the estate.
    expect((await receipts.getById('r3')).ownerId).toBe(deceased.id);
    expect((await savingsAccounts.getById('sav-1')).userId).toBe(heir.id);
    // Append-only transfer records + audit entries.
    const transferRows = await transfers.find({ receiptId: 'r1' });
    expect(transferRows).toHaveLength(1);
    expect(transferRows[0].fromOwnerId).toBe(deceased.id);
    expect(transferRows[0].toOwnerId).toBe(heir.id);
    expect(
      audit.record.mock.calls.some(
        ([input]) =>
          (input as { action: string }).action === 'succession.claim_approved' &&
          (input as { metadata?: { receiptsTransferred?: number } }).metadata
            ?.receiptsTransferred === 2
      )
    ).toBe(true);
    // The claim is decided; a second approval refuses.
    await expect(service.approveClaim(claim.id, admin)).rejects.toBeInstanceOf(ConflictException);
    // The deceased row is intact (estate linkage), status still deceased.
    expect((await users.getById(deceased.id)).phone).toBe('+2349041');
  });

  it('estate overview is estate-scoped: admin or claimant heir only', async () => {
    const { service, users, savingsAccounts } = build();
    const admin = await makeUser(users, '+2349050', ['admin']);
    const deceased = await makeUser(users, '+2349051');
    const heir = await makeUser(users, '+2349052');
    const stranger = await makeUser(users, '+2349053');
    await savingsAccounts.create({
      id: 'sav-9',
      userId: deceased.id,
      balanceKobo: 99_000,
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await service.markDeceased(deceased.id, admin, 'cert-z');

    await expect(service.estateOverview(deceased.id, stranger)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await service.fileClaim(
      deceased.id,
      { claimantName: 'Heir', relationship: 'son', evidenceRef: 'cert-2', heirUserId: heir.id },
      heir
    );
    const overview = await service.estateOverview(deceased.id, heir);
    expect(overview.totalSavingsKobo).toBe(99_000);
    expect(overview.accountStatus).toBe('deceased');
    expect(overview.claims).toHaveLength(1);
  });
});
