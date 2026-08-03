import {
  BadRequestException,
  ConflictException,
  ForbiddenException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { EquipmentListing, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import {
  createInMemoryEquipmentBookingRepository,
  createInMemoryEquipmentListingRepository
} from '../../database/repositories/mechanization.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import type { GeoIntelService } from '../geo-intel/geo-intel.service.js';
import { cancellationSplit } from './cancellation.js';
import {
  MechanizationService,
  MECH_HOLDS_ACCOUNT,
  MECH_TRANSITIONS,
  walletAccount,
  type CreateListingInput
} from './mechanization.service.js';

const owner: Pick<User, 'id' | 'roles'> = { id: 'user-owner', roles: ['farmer'] };
const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-farmer', roles: ['farmer'] };
const farmer2: Pick<User, 'id' | 'roles'> = { id: 'user-farmer-2', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-outsider', roles: ['supplier'] };

// Kano base; the plot is ~6.1 km away (inside the res-5 ring-1 service area,
// inside the 20 km included travel radius → no distance surcharge).
const BASE = { baseLat: 12.0022, baseLong: 8.592 };
const PLOT = { plotLat: 12.05, plotLong: 8.62 };
const FAR_PLOT = { plotLat: 10.5105, plotLong: 7.4165 }; // Kaduna — outside the area
const AVAILABILITY = [{ start: '2026-01-01T00:00:00.000Z', end: '2027-12-31T00:00:00.000Z' }];

function makeService(options: { geoIntel?: GeoIntelService } = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const service = new MechanizationService(
    events,
    new H3Service(),
    ledger,
    createInMemoryEquipmentListingRepository(),
    createInMemoryEquipmentBookingRepository(),
    options.geoIntel
  );
  return { service, ledger, events };
}

function listingInput(overrides: Partial<CreateListingInput> = {}): CreateListingInput {
  return {
    ownerUserId: owner.id,
    ownerType: 'cooperative',
    type: 'tractor',
    title: '75hp tractor with plough',
    ...BASE,
    serviceAreaResolution: 5,
    serviceAreaRing: 1,
    rates: { perHaNaira: 25000, perKmNaira: 500, includedKm: 20 },
    availability: AVAILABILITY,
    operatorLicenseRef: 'doc-license-1',
    ...overrides
  };
}

async function makeActiveListing(service: MechanizationService): Promise<EquipmentListing> {
  const listing = await service.createListing(listingInput(), owner.id);
  await service.setOperatorVerification(listing.id, 'verified', admin.id);
  return service.setListingStatus(listing.id, 'active', owner);
}

const SEP_WINDOW = { windowStart: '2026-09-10T08:00:00.000Z', windowEnd: '2026-09-10T12:00:00.000Z' };

function bookingInput(overrides: Record<string, unknown> = {}) {
  return { farmerId: farmer.id, ...PLOT, areaHa: 2, ...SEP_WINDOW, ...overrides };
}

async function walkToConfirmed(service: MechanizationService, listingId: string) {
  const booking = await service.requestBooking(listingId, bookingInput());
  await service.quoteBooking(booking.id, owner);
  return service.confirmBooking(booking.id, farmer);
}

describe('listings', () => {
  it('creates a DRAFT listing with a computed H3 service area', async () => {
    const { service } = makeService();
    const listing = await service.createListing(listingInput(), owner.id);
    expect(listing.status).toBe('draft');
    expect(listing.operatorVerification).toBe('pending');
    expect(listing.serviceAreaH3.length).toBe(7); // ring 1 = centre + 6 neighbours
    expect(listing.serviceAreaH3).toEqual([...listing.serviceAreaH3].sort());
    expect(listing.serviceAreaResolution).toBe(5);
  });

  it('rejects a listing without a usable rate', async () => {
    const { service } = makeService();
    await expect(
      service.createListing(listingInput({ rates: { perKmNaira: 100, includedKm: 0 } }), owner.id)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a service-area resolution outside 5–7', async () => {
    const { service } = makeService();
    await expect(
      service.createListing(listingInput({ serviceAreaResolution: 9 }), owner.id)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks activation until the operator is verified, then activates', async () => {
    const { service } = makeService();
    const listing = await service.createListing(listingInput(), owner.id);
    await expect(service.setListingStatus(listing.id, 'active', owner)).rejects.toBeInstanceOf(
      ConflictException
    );
    await service.setOperatorVerification(listing.id, 'verified', admin.id);
    expect((await service.setListingStatus(listing.id, 'active', owner)).status).toBe('active');
  });

  it('rejects illegal listing jumps (draft → paused)', async () => {
    const { service } = makeService();
    const listing = await service.createListing(listingInput(), owner.id);
    await expect(service.setListingStatus(listing.id, 'paused', owner)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('forbids non-owners from driving the listing lifecycle', async () => {
    const { service } = makeService();
    const listing = await service.createListing(listingInput(), owner.id);
    await service.setOperatorVerification(listing.id, 'verified', admin.id);
    await expect(service.setListingStatus(listing.id, 'active', outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('booking requests', () => {
  it('rejects bookings on non-active listings', async () => {
    const { service } = makeService();
    const listing = await service.createListing(listingInput(), owner.id);
    await expect(service.requestBooking(listing.id, bookingInput())).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('rejects plots outside the H3 service area', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    await expect(
      service.requestBooking(listing.id, bookingInput({ ...FAR_PLOT }))
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects windows outside listing availability', async () => {
    const { service } = makeService();
    const listing = await service.createListing(
      listingInput({
        availability: [{ start: '2026-09-01T00:00:00.000Z', end: '2026-09-05T00:00:00.000Z' }]
      }),
      owner.id
    );
    await service.setOperatorVerification(listing.id, 'verified', admin.id);
    await service.setListingStatus(listing.id, 'active', owner);
    await expect(service.requestBooking(listing.id, bookingInput())).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('requires estimatedHours for per-hour listings', async () => {
    const { service } = makeService();
    const listing = await service.createListing(
      listingInput({ rates: { perHourNaira: 12000, perKmNaira: 0, includedKm: 0 } }),
      owner.id
    );
    await service.setOperatorVerification(listing.id, 'verified', admin.id);
    await service.setListingStatus(listing.id, 'active', owner);
    await expect(service.requestBooking(listing.id, bookingInput())).rejects.toBeInstanceOf(
      BadRequestException
    );
    const ok = await service.requestBooking(listing.id, bookingInput({ estimatedHours: 4 }));
    expect(ok.status).toBe('requested');
  });
});

describe('booking workflow + ledger hold/release (stub execution mode)', () => {
  it('walks request → quote → confirm → in_service → completed → rated with a balanced hold', async () => {
    const { service, ledger } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    expect(booking.plotH3).toBeTruthy();

    const quoted = await service.quoteBooking(booking.id, owner);
    // 2 ha × ₦25,000 = 5,000,000 kobo; 6.13 km < 20 km included → no
    // surcharge; September multiplier 1.05 → 5,250,000 kobo.
    expect(quoted.quote?.areaComponentKobo).toBe(5_000_000);
    expect(quoted.quote?.distanceSurchargeKobo).toBe(0);
    expect(quoted.quote?.seasonalMultiplier).toBe(1.05);
    expect(quoted.quote?.totalKobo).toBe(5_250_000);

    const confirmed = await service.confirmBooking(booking.id, farmer);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.holdEntryId).toBeTruthy();
    // Hold posted: farmer wallet −total, holds account +total.
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(5_250_000);
    expect((await ledger.balance(walletAccount(farmer.id))).balanceKobo).toBe(-5_250_000);

    await service.startService(booking.id, owner);
    // First completion confirmation only records the timestamp.
    const half = await service.confirmCompletion(booking.id, farmer);
    expect(half.status).toBe('in_service');
    expect(half.farmerConfirmedCompletionAt).toBeTruthy();
    // Second confirmation completes and releases the hold to the owner.
    const completed = await service.confirmCompletion(booking.id, owner);
    expect(completed.status).toBe('completed');
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(0);
    expect((await ledger.balance(walletAccount(owner.id))).balanceKobo).toBe(5_250_000);

    const rated = await service.rateBooking(booking.id, farmer, 5, 'Clean ridging');
    expect(rated.status).toBe('rated');
    expect(rated.rating).toBe(5);
  });

  it('confirm is idempotent: a replay posts exactly one hold entry', async () => {
    const { service, ledger } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    await service.quoteBooking(booking.id, owner);
    await service.confirmBooking(booking.id, farmer);
    const replay = await service.confirmBooking(booking.id, farmer);
    expect(replay.status).toBe('confirmed');
    const holds = (await ledger.listEntries({ referenceId: booking.id })).filter((entry) =>
      entry.idempotencyKey.startsWith('mech-hold:')
    );
    expect(holds).toHaveLength(1);
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(5_250_000);
  });

  it('owner cancels after confirm → 100% refund to the farmer', async () => {
    const { service, ledger } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await walkToConfirmed(service, listing.id);
    const cancelled = await service.cancelBooking(booking.id, owner, 'breakdown');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledBy).toBe('owner');
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(0);
    expect((await ledger.balance(walletAccount(farmer.id))).balanceKobo).toBe(0);
    expect((await ledger.balance(walletAccount(owner.id))).balanceKobo).toBe(0);
  });

  it('farmer late cancel (<24h) releases 70/30 per the schedule', async () => {
    const { service, ledger } = makeService();
    const listing = await makeActiveListing(service);
    // Window starts 2 hours from "now" → the 70/30 row.
    const start = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const booking = await service.requestBooking(
      listing.id,
      bookingInput({ windowStart: start, windowEnd: end })
    );
    await service.quoteBooking(booking.id, owner);
    await service.confirmBooking(booking.id, farmer);
    const total = (await service.getBooking(booking.id)).quote!.totalKobo;
    const expected = cancellationSplit(total, 'farmer', start, Date.now());
    expect(expected.rule).toBe('farmer_very_late_cancel_70_30');
    await service.cancelBooking(booking.id, farmer);
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(0);
    expect((await ledger.balance(walletAccount(farmer.id))).balanceKobo).toBe(
      -total + expected.refundToFarmerKobo
    );
    expect((await ledger.balance(walletAccount(owner.id))).balanceKobo).toBe(
      expected.compensationToOwnerKobo
    );
  });

  it('dispute freezes the hold; admin resolution pays 100% either way', async () => {
    const { service, ledger } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await walkToConfirmed(service, listing.id);
    await service.startService(booking.id, owner);
    const disputed = await service.disputeBooking(booking.id, farmer, 'area not fully covered');
    expect(disputed.status).toBe('disputed');
    // Hold still parked while disputed.
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(5_250_000);
    // Non-admin cannot resolve.
    await expect(service.resolveDispute(booking.id, 'pay_owner', owner)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    const resolved = await service.resolveDispute(booking.id, 'refund_farmer', admin);
    expect(resolved.status).toBe('cancelled');
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(0);
    expect((await ledger.balance(walletAccount(farmer.id))).balanceKobo).toBe(0);
  });

  it('auto-complete finishes in_service bookings past window end + grace and pays the owner', async () => {
    const { service, ledger } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(
      listing.id,
      bookingInput({
        windowStart: '2026-03-10T08:00:00.000Z',
        windowEnd: '2026-03-10T12:00:00.000Z'
      })
    );
    await service.quoteBooking(booking.id, owner);
    await service.confirmBooking(booking.id, farmer);
    await service.startService(booking.id, owner);
    // Before grace expiry: nothing.
    expect(
      await service.autoCompleteExpired('2026-03-11T10:00:00.000Z')
    ).toHaveLength(0);
    const swept = await service.autoCompleteExpired('2026-03-11T13:00:00.000Z');
    expect(swept).toHaveLength(1);
    expect(swept[0].status).toBe('completed');
    const total = swept[0].quote!.totalKobo;
    expect((await ledger.balance(walletAccount(owner.id))).balanceKobo).toBe(total);
    expect((await ledger.balance(MECH_HOLDS_ACCOUNT)).balanceKobo).toBe(0);
  });
});

describe('state machine + party guards', () => {
  it('rejects illegal jumps with a 400', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    await expect(service.confirmBooking(booking.id, farmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(MECH_TRANSITIONS.rated).toEqual([]);
    expect(MECH_TRANSITIONS.cancelled).toEqual([]);
  });

  it('only the owner may quote, only the farmer may confirm', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    await expect(service.quoteBooking(booking.id, farmer)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await service.quoteBooking(booking.id, owner);
    await expect(service.confirmBooking(booking.id, owner)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(service.quoteBooking(booking.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('admins may drive any transition', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    const quoted = await service.quoteBooking(booking.id, admin);
    expect(quoted.status).toBe('quoted');
  });

  it('only the farmer may rate, and only completed bookings', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    await expect(service.rateBooking(booking.id, farmer, 5)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await service.quoteBooking(booking.id, owner);
    await service.confirmBooking(booking.id, farmer);
    await service.startService(booking.id, owner);
    await service.confirmCompletion(booking.id, farmer);
    await service.confirmCompletion(booking.id, owner);
    await expect(service.rateBooking(booking.id, farmer2, 5)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('scheduling conflicts (409 + deterministic suggestions)', () => {
  it('rejects a confirming booking whose buffered window clashes, with suggestions', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    // B: requested + quoted FIRST for 12:30–16:30 (before A holds the
    // schedule, so quoting succeeds; only confirmed/in_service bookings
    // reserve the schedule).
    const b = await service.requestBooking(
      listing.id,
      bookingInput({
        farmerId: farmer2.id,
        windowStart: '2026-09-10T12:30:00.000Z',
        windowEnd: '2026-09-10T16:30:00.000Z'
      })
    );
    await service.quoteBooking(b.id, owner);
    // A: 08:00–12:00 now confirmed — its buffered window leaves only a
    // ~37 min two-buffer gap requirement that B's 30 min gap violates.
    await walkToConfirmed(service, listing.id);
    const error = await service.confirmBooking(b.id, farmer2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as {
      suggestedWindows: { start: string; end: string }[];
      conflictingBookingIds: string[];
    };
    expect(body.conflictingBookingIds).toHaveLength(1);
    expect(body.suggestedWindows.length).toBeGreaterThan(0);
    // Deterministic: re-running the failing confirm yields identical suggestions.
    const again = await service.confirmBooking(b.id, farmer2).catch((e: unknown) => e);
    expect(((again as ConflictException).getResponse() as typeof body).suggestedWindows).toEqual(
      body.suggestedWindows
    );
  });

  it('accepts a booking whose gap clears both travel buffers', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    await walkToConfirmed(service, listing.id);
    // B starts 1 h after A ends — more than the ~37 min combined buffer.
    const b = await service.requestBooking(
      listing.id,
      bookingInput({
        farmerId: farmer2.id,
        windowStart: '2026-09-10T13:00:00.000Z',
        windowEnd: '2026-09-10T17:00:00.000Z'
      })
    );
    await service.quoteBooking(b.id, owner);
    expect((await service.confirmBooking(b.id, farmer2)).status).toBe('confirmed');
  });
});

describe('utilization stats (derived, not stored)', () => {
  it('rolls up booked hours, cleared revenue and completion rate', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await walkToConfirmed(service, listing.id);
    await service.startService(booking.id, owner);
    await service.confirmCompletion(booking.id, farmer);
    await service.confirmCompletion(booking.id, owner);

    const cancelled = await service.requestBooking(
      listing.id,
      bookingInput({
        farmerId: farmer2.id,
        windowStart: '2026-09-11T08:00:00.000Z',
        windowEnd: '2026-09-11T10:00:00.000Z'
      })
    );
    await service.cancelBooking(cancelled.id, farmer2);

    const stats = await service.utilizationStats(owner.id);
    expect(stats.listingCount).toBe(1);
    expect(stats.bookedHours).toBe(4); // only schedule-holding/completed bookings count
    expect(stats.completedBookings).toBe(1);
    expect(stats.cancelledBookings).toBe(1);
    expect(stats.completionRate).toBe(0.5);
    expect(stats.revenueClearedKobo).toBe(5_250_000);
  });
});

describe('weather advisory hook (advisory only, basis carried)', () => {
  it('records not-configured honesty when no flood port is wired', async () => {
    const { service } = makeService();
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    const quoted = await service.quoteBooking(booking.id, owner);
    expect(quoted.advisory?.severe).toBe(false);
    expect(quoted.advisory?.basis).toBe('not-configured');
    expect(quoted.advisory?.h3Cell).toBe(quoted.plotH3);
  });

  it('attaches a severe advisory with the port basis — and never blocks the quote', async () => {
    const geoIntel = {
      assessFloodRisk: async () => ({
        severity: 'severe',
        driver: 'http',
        source: 'flood-ml sidecar v1'
      })
    } as unknown as GeoIntelService;
    const { service } = makeService({ geoIntel });
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    const quoted = await service.quoteBooking(booking.id, owner);
    expect(quoted.status).toBe('quoted');
    expect(quoted.advisory?.severe).toBe(true);
    expect(quoted.advisory?.basis).toBe('http:flood-ml sidecar v1');
    expect(quoted.advisory?.severity).toBe('severe');
  });

  it('degrades honestly (unavailable basis) when the flood port throws', async () => {
    const geoIntel = {
      assessFloodRisk: async () => {
        throw new Error('sidecar unreachable');
      }
    } as unknown as GeoIntelService;
    const { service } = makeService({ geoIntel });
    const listing = await makeActiveListing(service);
    const booking = await service.requestBooking(listing.id, bookingInput());
    const quoted = await service.quoteBooking(booking.id, owner);
    expect(quoted.status).toBe('quoted');
    expect(quoted.advisory?.severe).toBe(false);
    expect(quoted.advisory?.basis).toBe('unavailable:geo-intel');
  });
});
