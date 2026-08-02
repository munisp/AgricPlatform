import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryDisbursementRepository } from '../../database/repositories/livestock-trade.repository.js';
import { DisbursementsService } from './disbursements.service.js';

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
    service = new DisbursementsService(
      users as never,
      audit as never,
      new DomainEventsService(outbox),
      disbursements
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
