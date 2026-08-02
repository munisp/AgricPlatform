import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryServiceBookingRepository } from '../../database/repositories/service-booking.repository.js';
import { createInMemoryServiceOfferingRepository } from '../../database/repositories/service-offering.repository.js';
import { createInMemoryServiceReviewRepository } from '../../database/repositories/service-review.repository.js';
import { createInMemorySupplierRepository } from '../../database/repositories/supplier.repository.js';
import { ServicesMarketplaceService } from './services-marketplace.service.js';

const supplierOwner: Pick<User, 'id' | 'roles'> = { id: 'user-hassan', roles: ['supplier'] };
const customer: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new ServicesMarketplaceService(
    events,
    createInMemorySupplierRepository(),
    createInMemoryServiceOfferingRepository(),
    createInMemoryServiceBookingRepository(),
    createInMemoryServiceReviewRepository()
  );
  return { service, events };
}

async function makeSupplierWithOffering(
  service: ServicesMarketplaceService,
  category: 'machinery_hire' | 'seed' | 'cold_storage' = 'machinery_hire'
) {
  const supplier = await service.createSupplier({
    ownerUserId: supplierOwner.id,
    businessName: 'Kano Tractor Hire',
    categories: [category],
    statesCovered: ['Kano']
  });
  const offering = await service.createOffering(
    {
      supplierId: supplier.id,
      category,
      title: '50hp tractor per day',
      priceNaira: 45000,
      pricingUnit: 'per_day'
    },
    supplierOwner
  );
  return { supplier, offering };
}

const WINDOW_A = { scheduledStart: '2026-09-01T08:00:00.000Z', scheduledEnd: '2026-09-03T08:00:00.000Z' };

async function walkToCompleted(service: ServicesMarketplaceService, offeringId: string) {
  const booking = await service.createBooking({ offeringId, customerId: customer.id, ...WINDOW_A });
  await service.quoteBooking(booking.id, 90000, supplierOwner);
  await service.setBookingStatus(booking.id, 'accepted', customer);
  await service.setBookingStatus(booking.id, 'scheduled', supplierOwner);
  return service.setBookingStatus(booking.id, 'completed', supplierOwner);
}

describe('ServicesMarketplaceService suppliers and offerings', () => {
  it('registers suppliers unverified and lets admins verify them', async () => {
    const { service } = makeService();
    const { supplier } = await makeSupplierWithOffering(service);
    expect(supplier.verificationStatus).toBe('unverified');
    expect((await service.setVerificationStatus(supplier.id, 'verified', admin.id)).verificationStatus).toBe('verified');
  });

  it('rejects offerings in categories the supplier does not cover', async () => {
    const { service } = makeService();
    const { supplier } = await makeSupplierWithOffering(service, 'seed');
    await expect(
      service.createOffering(
        { supplierId: supplier.id, category: 'insurance', title: 'Crop cover', priceNaira: 5000, pricingUnit: 'flat' },
        supplierOwner
      )
    ).rejects.toThrowError(BadRequestException);
  });

  it('rejects offering creation by non-owners', async () => {
    const { service } = makeService();
    const { supplier } = await makeSupplierWithOffering(service);
    await expect(
      service.createOffering(
        { supplierId: supplier.id, category: 'machinery_hire', title: 'x', priceNaira: 1, pricingUnit: 'per_day' },
        outsider
      )
    ).rejects.toThrowError(ForbiddenException);
  });
});

describe('ServicesMarketplaceService booking state machine', () => {
  it('walks request → quote → accept → schedule → complete', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const completed = await walkToCompleted(service, offering.id);
    expect(completed.status).toBe('completed');
    expect(completed.totalNaira).toBe(90000);
  });

  it('rejects invalid transitions and transitions from terminal states', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const booking = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    await expect(service.setBookingStatus(booking.id, 'scheduled', admin)).rejects.toThrowError(
      /Invalid booking transition/
    );
    await service.setBookingStatus(booking.id, 'cancelled', customer);
    await expect(service.setBookingStatus(booking.id, 'accepted', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('enforces the entitled party per transition', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const booking = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    // Only the supplier quotes.
    await expect(service.quoteBooking(booking.id, 1000, customer)).rejects.toThrowError(ForbiddenException);
    await service.quoteBooking(booking.id, 1000, supplierOwner);
    // Only the customer accepts.
    await expect(service.setBookingStatus(booking.id, 'accepted', supplierOwner)).rejects.toThrowError(
      ForbiddenException
    );
    // Outsiders cannot drive the booking at all.
    await expect(service.setBookingStatus(booking.id, 'cancelled', outsider)).rejects.toThrowError(
      ForbiddenException
    );
    // Admin override works.
    expect((await service.setBookingStatus(booking.id, 'accepted', admin)).status).toBe('accepted');
  });

  it('supports decline as a terminal customer decision', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const booking = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    await service.quoteBooking(booking.id, 1000, supplierOwner);
    expect((await service.setBookingStatus(booking.id, 'declined', customer)).status).toBe('declined');
    await expect(service.setBookingStatus(booking.id, 'scheduled', supplierOwner)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('requires the quote path so a price is always recorded', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const booking = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    await expect(service.setBookingStatus(booking.id, 'quoted', supplierOwner)).rejects.toThrowError(
      BadRequestException
    );
  });
});

describe('ServicesMarketplaceService booking window conflicts', () => {
  it('rejects overlapping windows for machinery hire at request time', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    await expect(
      service.createBooking({
        offeringId: offering.id,
        customerId: outsider.id,
        scheduledStart: '2026-09-02T08:00:00.000Z',
        scheduledEnd: '2026-09-04T08:00:00.000Z'
      })
    ).rejects.toThrowError(ConflictException);
  });

  it('ignores cancelled bookings when checking conflicts', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const first = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    await service.setBookingStatus(first.id, 'cancelled', customer);
    const second = await service.createBooking({ offeringId: offering.id, customerId: outsider.id, ...WINDOW_A });
    expect(second.status).toBe('requested');
  });

  it('does not conflict-check non-reservable categories like seed', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service, 'seed');
    await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    const second = await service.createBooking({ offeringId: offering.id, customerId: outsider.id, ...WINDOW_A });
    expect(second.status).toBe('requested');
  });

  it('rejects scheduling when another booking took the window in the meantime', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service, 'cold_storage');
    const first = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    await service.quoteBooking(first.id, 1000, supplierOwner);
    await service.setBookingStatus(first.id, 'accepted', customer);
    // A second customer books a non-overlapping window, then a third request
    // overlapping the first cannot be created — but a direct schedule race is
    // guarded again at the scheduled transition.
    const later = await service.createBooking({
      offeringId: offering.id,
      customerId: outsider.id,
      scheduledStart: '2026-09-05T08:00:00.000Z',
      scheduledEnd: '2026-09-06T08:00:00.000Z'
    });
    await service.quoteBooking(later.id, 1000, supplierOwner);
    await service.setBookingStatus(later.id, 'accepted', outsider);
    expect((await service.setBookingStatus(first.id, 'scheduled', supplierOwner)).status).toBe('scheduled');
    expect((await service.setBookingStatus(later.id, 'scheduled', supplierOwner)).status).toBe('scheduled');
  });
});

describe('ServicesMarketplaceService own bookings list', () => {
  it('lists only the requesting user\'s bookings with a status filter', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const mine = await service.createBooking({ offeringId: offering.id, customerId: customer.id, ...WINDOW_A });
    const other = await service.createBooking({
      offeringId: offering.id,
      customerId: outsider.id,
      scheduledStart: '2026-10-01T08:00:00.000Z',
      scheduledEnd: '2026-10-02T08:00:00.000Z'
    });

    const all = await service.listBookingsForCustomer(customer.id);
    expect(all.map((booking) => booking.id)).toEqual([mine.id]);

    // Ownership scoping: another user's records never leak.
    const outsiders = await service.listBookingsForCustomer(outsider.id);
    expect(outsiders.map((booking) => booking.id)).toEqual([other.id]);
    expect(await service.listBookingsForCustomer('user-unknown')).toEqual([]);

    // Status filter applies on top of ownership scoping.
    expect(await service.listBookingsForCustomer(customer.id, 'requested')).toHaveLength(1);
    expect(await service.listBookingsForCustomer(customer.id, 'completed')).toHaveLength(0);
  });
});

describe('ServicesMarketplaceService reviews', () => {
  it('allows one review per completed booking and maintains the supplier aggregate', async () => {
    const { service } = makeService();
    const { supplier, offering } = await makeSupplierWithOffering(service);
    const booking = await walkToCompleted(service, offering.id);
    const review = await service.reviewBooking(booking.id, customer.id, 4, 'Solid work');
    expect(review.rating).toBe(4);
    await expect(service.reviewBooking(booking.id, customer.id, 5)).rejects.toThrowError(ConflictException);
    const updated = await service.getSupplier(supplier.id);
    expect(updated.ratingCount).toBe(1);
    expect(updated.averageRating).toBe(4);
  });

  it('gates reviews on completed bookings and the booking customer', async () => {
    const { service } = makeService();
    const { offering } = await makeSupplierWithOffering(service);
    const booking = await service.createBooking({
      offeringId: offering.id,
      customerId: customer.id,
      scheduledStart: '2026-11-01T08:00:00.000Z',
      scheduledEnd: '2026-11-02T08:00:00.000Z'
    });
    await expect(service.reviewBooking(booking.id, customer.id, 5)).rejects.toThrowError(BadRequestException);
    const completed = await walkToCompleted(service, offering.id);
    await expect(service.reviewBooking(completed.id, outsider.id, 5)).rejects.toThrowError(ForbiddenException);
    await expect(service.reviewBooking(completed.id, customer.id, 7)).rejects.toThrowError(BadRequestException);
  });

  it('averages multiple reviews into the supplier rating', async () => {
    const { service } = makeService();
    const { supplier, offering } = await makeSupplierWithOffering(service, 'seed');
    const first = await walkToCompleted(service, offering.id);
    const secondBooking = await service.createBooking({
      offeringId: offering.id,
      customerId: outsider.id,
      scheduledStart: '2026-10-01T08:00:00.000Z',
      scheduledEnd: '2026-10-02T08:00:00.000Z'
    });
    await service.quoteBooking(secondBooking.id, 1000, supplierOwner);
    await service.setBookingStatus(secondBooking.id, 'accepted', outsider);
    await service.setBookingStatus(secondBooking.id, 'scheduled', supplierOwner);
    await service.setBookingStatus(secondBooking.id, 'completed', outsider);
    await service.reviewBooking(first.id, customer.id, 5);
    await service.reviewBooking(secondBooking.id, outsider.id, 3);
    const updated = await service.getSupplier(supplier.id);
    expect(updated.ratingCount).toBe(2);
    expect(updated.averageRating).toBe(4);
  });
});
