import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGroupRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository
} from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { CreditGroupsService } from './groups.service.js';
import { CreditSavingsService } from './savings.service.js';

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const other: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['farmer'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-chidi', roles: ['farmer'] };

function makeServices() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const groups = createInMemoryCreditGroupRepository();
  const members = createInMemoryCreditGroupMemberRepository();
  const transactions = createInMemoryCreditSavingsTransactionRepository();
  const accounts = createInMemoryCreditSavingsAccountRepository(transactions);
  const savings = new CreditSavingsService(events, accounts, transactions, groups, members);
  const groupsService = new CreditGroupsService(events, groups, members);
  return { savings, groupsService, accounts, transactions };
}

describe('CreditSavingsService personal accounts', () => {
  it('auto-provisions the own account and tracks deposits', async () => {
    const { savings } = makeServices();
    const account = await savings.getOwnAccount(farmer);
    expect(account.balanceKobo).toBe(0);
    expect((await savings.getOwnAccount(farmer)).id).toBe(account.id); // stable
    const deposit = await savings.depositOwn(farmer, 250_000, 'ref-dep-1');
    expect(deposit.account.balanceKobo).toBe(250_000);
    expect(deposit.transaction.balanceAfterKobo).toBe(250_000);
    expect(deposit.replay).toBe(false);
  });

  it('guards the balance: withdrawals may never go negative', async () => {
    const { savings } = makeServices();
    await savings.depositOwn(farmer, 100_000, 'ref-dep-2');
    await expect(savings.withdrawOwn(farmer, 100_001, 'ref-wd-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
    const withdrawal = await savings.withdrawOwn(farmer, 60_000, 'ref-wd-2');
    expect(withdrawal.account.balanceKobo).toBe(40_000);
    expect(withdrawal.transaction.balanceAfterKobo).toBe(40_000);
  });

  it('serialises concurrent withdrawals via the guarded balance CAS', async () => {
    const { savings } = makeServices();
    await savings.depositOwn(farmer, 100_000, 'ref-dep-3');
    // Each withdrawal fits the balance alone; together they would overdraw.
    // The synchronous CAS body serialises them: one succeeds, the other
    // re-reads and fails closed with an insufficient-funds 400.
    const first = savings.withdrawOwn(farmer, 70_000, 'ref-wd-3a');
    const second = savings.withdrawOwn(farmer, 70_000, 'ref-wd-3b');
    await expect(second).rejects.toBeInstanceOf(BadRequestException);
    expect((await first).account.balanceKobo).toBe(30_000);
  });

  it('replays idempotently by ref and rejects ref reuse with different parameters', async () => {
    const { savings } = makeServices();
    const original = await savings.depositOwn(farmer, 50_000, 'ref-dep-4');
    const replay = await savings.depositOwn(farmer, 50_000, 'ref-dep-4');
    expect(replay.replay).toBe(true);
    expect(replay.transaction.id).toBe(original.transaction.id);
    expect(replay.account.balanceKobo).toBe(50_000); // not double-applied
    await expect(savings.depositOwn(farmer, 75_000, 'ref-dep-4')).rejects.toBeInstanceOf(
      ConflictException
    );
    await expect(savings.withdrawOwn(farmer, 50_000, 'ref-dep-4')).rejects.toBeInstanceOf(
      ConflictException
    );
    const ledger = await savings.listOwnTransactions(farmer);
    expect(ledger).toHaveLength(1);
  });

  it('validates amounts and refs at the boundary', async () => {
    const { savings } = makeServices();
    await expect(savings.depositOwn(farmer, 0, 'ref-x')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(savings.depositOwn(farmer, 10.5, 'ref-x')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(savings.depositOwn(farmer, 1000, '')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

describe('CreditSavingsService group accounts', () => {
  async function groupWithMember(services: ReturnType<typeof makeServices>) {
    const { group } = await services.groupsService.createGroup({ name: 'VSLA' }, farmer);
    await services.groupsService.join(group.id, other);
    return group;
  }

  it('lets the leader move group savings while members read', async () => {
    const services = makeServices();
    const group = await groupWithMember(services);
    const account = await services.savings.getGroupAccount(group.id, other); // member read
    expect(account.groupId).toBe(group.id);
    await expect(
      services.savings.depositGroup(group.id, other, 100_000, 'ref-gdep-1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    const deposit = await services.savings.depositGroup(group.id, farmer, 100_000, 'ref-gdep-1');
    expect(deposit.account.balanceKobo).toBe(100_000);
    const withdrawal = await services.savings.withdrawGroup(group.id, farmer, 25_000, 'ref-gwd-1');
    expect(withdrawal.account.balanceKobo).toBe(75_000);
    const ledger = await services.savings.listGroupTransactions(group.id, other);
    expect(ledger).toHaveLength(2);
  });

  it('denies non-members any access to the group account', async () => {
    const services = makeServices();
    const group = await groupWithMember(services);
    await expect(services.savings.getGroupAccount(group.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(
      services.savings.depositGroup(group.id, outsider, 1000, 'ref-gdep-2')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps group and personal accounts isolated', async () => {
    const services = makeServices();
    const group = await groupWithMember(services);
    await services.savings.depositGroup(group.id, farmer, 40_000, 'ref-gdep-3');
    await services.savings.depositOwn(farmer, 10_000, 'ref-pdep-1');
    const groupAccount = await services.savings.getGroupAccount(group.id, farmer);
    const ownAccount = await services.savings.getOwnAccount(farmer);
    expect(groupAccount.id).not.toBe(ownAccount.id);
    expect(groupAccount.balanceKobo).toBe(40_000);
    expect(ownAccount.balanceKobo).toBe(10_000);
  });
});
