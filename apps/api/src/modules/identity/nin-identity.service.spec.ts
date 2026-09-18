import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { LoanApplication } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCreditLoanRepository
} from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryLoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import {
  createInMemoryAccountMergeRepository,
  createInMemoryNinAnchorRepository
} from '../../database/repositories/nin-anchor.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from '../users/users.service.js';
import { hashNin, NinIdentityService } from './nin-identity.service.js';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const audit = { record: vi.fn(async (input: unknown) => input) };
  const anchors = createInMemoryNinAnchorRepository();
  const merges = createInMemoryAccountMergeRepository();
  const creditLoans = createInMemoryCreditLoanRepository();
  const loanApplications = createInMemoryLoanApplicationRepository();
  const service = new NinIdentityService(
    users,
    new DomainEventsService(createInMemoryOutboxRepository()),
    audit as never,
    anchors,
    merges,
    creditLoans,
    loanApplications
  );
  return { service, users, audit, anchors, merges, creditLoans, loanApplications };
}

async function makeUser(users: UsersService, phone: string, roles: Array<'farmer' | 'admin'> = ['farmer']) {
  return users.create({ phone, fullName: 'Identity User', roles, preferredLanguage: 'en' });
}

const NIN_A = '12345678901';
const NIN_B = '10987654321';

describe('NinIdentityService (V-45)', () => {
  it('anchors hash-only (cleartext NIN never stored), idempotent re-anchor, one per user', async () => {
    const { service, users, anchors } = build();
    const farmer = await makeUser(users, '+2349101');
    const anchor = await service.anchorNin(farmer.id, NIN_A, farmer);
    expect(anchor.ninHash).toBe(hashNin(NIN_A));
    expect(JSON.stringify(anchor)).not.toContain(NIN_A);
    // Idempotent re-anchor of the same NIN returns the existing anchor.
    expect((await service.anchorNin(farmer.id, NIN_A, farmer)).id).toBe(anchor.id);
    // A different NIN on the same account is a conflict.
    await expect(service.anchorNin(farmer.id, NIN_B, farmer)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(await anchors.find({ userId: farmer.id })).toHaveLength(1);
    // Malformed NIN refused.
    await expect(service.anchorNin(farmer.id, '123', farmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('flags the same NIN across two accounts in the duplicate report', async () => {
    const { service, users } = build();
    const admin = await makeUser(users, '+2349110', ['admin']);
    const a = await makeUser(users, '+2349111');
    const b = await makeUser(users, '+2349112'); // second SIM, same person
    const c = await makeUser(users, '+2349113');
    await service.anchorNin(a.id, NIN_A, a);
    await service.anchorNin(b.id, NIN_A, b);
    await service.anchorNin(c.id, NIN_B, c);
    const report = await service.duplicateReport(admin);
    expect(report).toHaveLength(1);
    expect(report[0].ninHash).toBe(hashNin(NIN_A));
    expect(report[0].userIds).toEqual([a.id, b.id].sort());
    // Non-admin cannot run the report.
    await expect(service.duplicateReport(a)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('merge consolidates credit histories and suspends the duplicate, with audit', async () => {
    const { service, users, merges, creditLoans, loanApplications, audit } = build();
    const admin = await makeUser(users, '+2349120', ['admin']);
    const primary = await makeUser(users, '+2349121');
    const duplicate = await makeUser(users, '+2349122');
    await service.anchorNin(primary.id, NIN_A, primary);
    await service.anchorNin(duplicate.id, NIN_A, duplicate);
    // Credit history split across the two identities.
    await creditLoans.create({
      id: 'cl-1',
      applicantUserId: duplicate.id,
      productId: 'prod-1',
      principalKobo: 500_000,
      status: 'disbursed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await loanApplications.create({
      id: 'la-1',
      applicantId: duplicate.id,
      lenderId: 'lender-1',
      amountKobo: 300_000,
      status: 'approved',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    } as LoanApplication);

    const merge = await service.mergeAccounts(primary.id, duplicate.id, admin);

    expect(merge.creditLoansMoved).toBe(1);
    expect(merge.loanApplicationsMoved).toBe(1);
    // Histories consolidated onto the primary:
    expect((await creditLoans.getById('cl-1')).applicantUserId).toBe(primary.id);
    expect((await loanApplications.getById('la-1')).applicantId).toBe(primary.id);
    expect(await users.statusFor(duplicate.id)).toBe('suspended');
    expect((await merges.find({ duplicateUserId: duplicate.id }))[0].id).toBe(merge.id);
    // The duplicate's anchor folds out of the duplicate report.
    const report = await service.duplicateReport(admin);
    expect(report).toHaveLength(0);
    expect(
      audit.record.mock.calls.some(
        ([input]) => (input as { action: string }).action === 'identity.accounts_merged'
      )
    ).toBe(true);
  });

  it('merge requires admin and refuses deceased estates (succession owns those)', async () => {
    const { service, users } = build();
    const admin = await makeUser(users, '+2349130', ['admin']);
    const a = await makeUser(users, '+2349131');
    const b = await makeUser(users, '+2349132');
    await expect(service.mergeAccounts(a.id, b.id, a)).rejects.toBeInstanceOf(ForbiddenException);
    // Unanchored accounts need a documented admin note.
    await expect(service.mergeAccounts(a.id, b.id, admin)).rejects.toBeInstanceOf(
      BadRequestException
    );
    const merged = await service.mergeAccounts(a.id, b.id, admin, 'manual review: same person, ID sighted');
    expect(merged.note).toContain('manual review');
    // Deceased accounts are refused.
    const c = await makeUser(users, '+2349133');
    const d = await makeUser(users, '+2349134');
    await users.setStatus(d.id, 'deceased');
    await expect(service.mergeAccounts(c.id, d.id, admin, 'note')).rejects.toBeInstanceOf(
      ConflictException
    );
  });
});
