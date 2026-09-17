import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryDisbursementRepository } from '../../database/repositories/livestock-trade.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  DISBURSEMENT_DONOR_FLOAT_ACCOUNT,
  DISBURSEMENT_PROGRAMME_SPEND_ACCOUNT,
  DisbursementsService,
  disbursementReleaseLedgerKey
} from './disbursements.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const donor = asUser('donor-1', ['donor']);
const otherDonor = asUser('donor-2', ['donor']);
const admin = asUser('admin-1', ['admin']);
const beneficiary = asUser('farmer-1', ['farmer']);

describe('DisbursementsService', () => {
  let disbursements: ReturnType<typeof createInMemoryDisbursementRepository>;
  let users: { getById: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let ledger: LedgerService;
  let service: DisbursementsService;

  const input = {
    programmeId: 'programme-livestock-1',
    milestone: 'vaccination' as const,
    amountKobo: 5_000_00,
    beneficiaryUserId: beneficiary.id
  };

  beforeEach(() => {
    disbursements = createInMemoryDisbursementRepository();
    users = { getById: vi.fn().mockImplementation(async (id: string) => ({ id, roles: [] })) };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    ledger = new LedgerService(
      events,
      createInMemoryLedgerAccountRepository(),
      createInMemoryLedgerEntryRepository()
    );
    service = new DisbursementsService(
      users as never,
      audit as never,
      events,
      disbursements,
      ledger
    );
  });

  it('schedules a disbursement (donor role only)', async () => {
    const scheduled = await service.schedule(donor, input);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.donorUserId).toBe(donor.id);
    await expect(service.schedule(beneficiary, input)).rejects.toThrow('Requires one of roles');
  });

  it('validates integer kobo amounts and the beneficiary', async () => {
    await expect(service.schedule(donor, { ...input, amountKobo: 4.5 })).rejects.toThrow('kobo');
    users.getById.mockRejectedValueOnce(new Error('User not found.'));
    await expect(service.schedule(donor, input)).rejects.toThrow('User not found.');
  });

  it('never schedules the same (programme, milestone, beneficiary) twice', async () => {
    await service.schedule(donor, input);
    await expect(service.schedule(otherDonor, input)).rejects.toThrow('already exists');
    // A different milestone for the same beneficiary is fine.
    const other = await service.schedule(donor, { ...input, milestone: 'enrolment' });
    expect(other.milestone).toBe('enrolment');
  });

  it('releases scheduled funds and is idempotent on re-release', async () => {
    const scheduled = await service.schedule(donor, input);
    const released = await service.release(donor, scheduled.id);
    expect(released.status).toBe('released');
    expect(released.releasedAt).toBeTruthy();
    const replayed = await service.release(donor, scheduled.id);
    expect(replayed).toEqual(released);
    const events = await outbox.list();
    expect(
      events.filter((event) => event.name === 'livestock_trade.disbursement.released')
    ).toHaveLength(1);
  });

  it('V-56: two concurrent releases — one wins the CAS, exactly one event and one ledger leg', async () => {
    const scheduled = await service.schedule(donor, input);
    const [first, second] = await Promise.all([
      service.release(donor, scheduled.id),
      service.release(admin, scheduled.id)
    ]);
    expect(first.status).toBe('released');
    expect(second.status).toBe('released');
    // Exactly one release event was published (the loser adopted the winner).
    const events = await outbox.list();
    const releaseEvents = events.filter(
      (event) => event.name === 'livestock_trade.disbursement.released'
    );
    expect(releaseEvents).toHaveLength(1);
    // The ledger leg posted exactly once and balances.
    const legs = await ledger.listEntries({ referenceId: scheduled.id });
    expect(legs).toHaveLength(1);
    expect(legs[0].idempotencyKey).toBe(disbursementReleaseLedgerKey(scheduled.id));
    const spend = await ledger.balance(DISBURSEMENT_PROGRAMME_SPEND_ACCOUNT);
    const float = await ledger.balance(DISBURSEMENT_DONOR_FLOAT_ACCOUNT);
    expect(spend.debitsKobo).toBe(input.amountKobo);
    expect(float.creditsKobo).toBe(input.amountKobo);
  });

  it('V-56: a release replay re-drives the ledger leg idempotently (no double-post)', async () => {
    const scheduled = await service.schedule(donor, input);
    await service.release(donor, scheduled.id);
    await service.release(donor, scheduled.id);
    await service.release(admin, scheduled.id);
    const legs = await ledger.listEntries({ referenceId: scheduled.id });
    expect(legs).toHaveLength(1);
    expect((await ledger.balance(DISBURSEMENT_PROGRAMME_SPEND_ACCOUNT)).debitsKobo).toBe(
      input.amountKobo
    );
  });

  it('restricts release to the scheduling donor or admin', async () => {
    const scheduled = await service.schedule(donor, input);
    await expect(service.release(otherDonor, scheduled.id)).rejects.toThrow('scheduling donor');
    await expect(service.release(admin, scheduled.id)).resolves.toMatchObject({
      status: 'released'
    });
  });

  it('confirms receipt (beneficiary or admin) only after release', async () => {
    const scheduled = await service.schedule(donor, input);
    await expect(service.confirm(beneficiary, scheduled.id)).rejects.toThrow(
      'only released disbursements'
    );
    await service.release(donor, scheduled.id);
    const confirmed = await service.confirm(beneficiary, scheduled.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).toBeTruthy();
    await expect(service.release(donor, scheduled.id)).rejects.toThrow(
      'only scheduled disbursements'
    );
  });

  it('scopes beneficiary listing to self or admin', async () => {
    await service.schedule(donor, input);
    expect(await service.listForBeneficiary(beneficiary, beneficiary.id)).toHaveLength(1);
    await expect(service.listForBeneficiary(donor, beneficiary.id)).rejects.toThrow(
      'You may only access your own records'
    );
    expect(await service.listForBeneficiary(admin, beneficiary.id)).toHaveLength(1);
  });

  it('lists scheduled disbursements for the donor', async () => {
    await service.schedule(donor, input);
    expect(await service.listMine(donor)).toHaveLength(1);
    expect(await service.listMine(otherDonor)).toHaveLength(0);
  });
});
