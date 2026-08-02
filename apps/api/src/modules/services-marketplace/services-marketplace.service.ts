import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  ApiListResponse,
  BookingStatus,
  ServiceBooking,
  ServiceOffering,
  ServiceReview,
  ServiceSupplier,
  SupplierCategory,
  User
} from '@agric-platform/shared';
import { CONFLICT_CHECKED_CATEGORIES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  SERVICE_BOOKING_REPOSITORY,
  SERVICE_OFFERING_REPOSITORY,
  SERVICE_REVIEW_REPOSITORY,
  SUPPLIER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ServiceBookingRepository } from '../../database/repositories/service-booking.repository.js';
import type { ServiceOfferingRepository } from '../../database/repositories/service-offering.repository.js';
import type { ServiceReviewRepository } from '../../database/repositories/service-review.repository.js';
import type {
  SupplierCriteria,
  SupplierRepository
} from '../../database/repositories/supplier.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';

export interface CreateSupplierInput {
  ownerUserId: string;
  businessName: string;
  categories: SupplierCategory[];
  statesCovered?: string[];
  lgasCovered?: string[];
}

export interface CreateOfferingInput {
  supplierId: string;
  category: SupplierCategory;
  title: string;
  description?: string;
  priceNaira: number;
  pricingUnit: ServiceOffering['pricingUnit'];
}

export interface CreateBookingInput {
  offeringId: string;
  customerId: string;
  quantity?: number;
  scheduledStart: string;
  scheduledEnd: string;
  notes?: string;
}

type Actor = Pick<User, 'id' | 'roles'>;
type BookingParty = 'customer' | 'supplier';

/** Transition guards for the booking state machine. */
const ALLOWED_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  requested: ['quoted', 'cancelled'],
  quoted: ['accepted', 'declined', 'cancelled'],
  accepted: ['scheduled', 'cancelled'],
  scheduled: ['completed', 'cancelled'],
  declined: [],
  completed: [],
  cancelled: []
};

/** Which party may drive each transition target (admin always may). */
const TRANSITION_ACTORS: Readonly<Record<BookingStatus, readonly BookingParty[]>> = {
  requested: [],
  quoted: ['supplier'],
  accepted: ['customer'],
  declined: ['customer'],
  scheduled: ['supplier'],
  completed: ['customer', 'supplier'],
  cancelled: ['customer', 'supplier']
};

@Injectable()
export class ServicesMarketplaceService {
  constructor(
    private readonly domainEvents: DomainEventsService,
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(SERVICE_OFFERING_REPOSITORY) private readonly offerings: ServiceOfferingRepository,
    @Inject(SERVICE_BOOKING_REPOSITORY) private readonly bookings: ServiceBookingRepository,
    @Inject(SERVICE_REVIEW_REPOSITORY) private readonly reviews: ServiceReviewRepository
  ) {}

  // -- Supplier directory -----------------------------------------------------

  async listSuppliers(
    filter: SupplierCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<ServiceSupplier>> {
    return this.suppliers.searchPage(
      {
        category: filter.category,
        state: filter.state,
        verificationStatus: filter.verificationStatus
      },
      filter.page,
      filter.pageSize
    );
  }

  async getSupplier(id: string): Promise<ServiceSupplier> {
    return this.suppliers.getById(id);
  }

  async createSupplier(input: CreateSupplierInput): Promise<ServiceSupplier> {
    const supplier: ServiceSupplier = {
      id: newId('supplier'),
      ownerUserId: input.ownerUserId,
      businessName: input.businessName,
      categories: input.categories,
      statesCovered: input.statesCovered ?? [],
      lgasCovered: input.lgasCovered ?? [],
      verificationStatus: 'unverified',
      averageRating: 0,
      ratingCount: 0,
      createdAt: new Date().toISOString()
    };
    const created = await this.suppliers.create(supplier);
    await this.domainEvents.publish(
      'services.supplier.registered',
      { supplierId: created.id },
      input.ownerUserId
    );
    return created;
  }

  async setVerificationStatus(
    id: string,
    verificationStatus: ServiceSupplier['verificationStatus'],
    actorId: string
  ): Promise<ServiceSupplier> {
    const updated = await this.suppliers.update(id, { verificationStatus });
    await this.domainEvents.publish(
      'services.supplier.verification_changed',
      { supplierId: id, verificationStatus },
      actorId
    );
    return updated;
  }

  // -- Offerings ---------------------------------------------------------------

  async listOfferings(filter: {
    supplierId?: string;
    category?: SupplierCategory;
    active?: boolean;
  }): Promise<ServiceOffering[]> {
    return this.offerings.find(filter);
  }

  async getOffering(id: string): Promise<ServiceOffering> {
    return this.offerings.getById(id);
  }

  async createOffering(input: CreateOfferingInput, actor: Actor): Promise<ServiceOffering> {
    const supplier = await this.suppliers.getById(input.supplierId);
    this.assertSupplierParty(supplier, actor);
    if (!supplier.categories.includes(input.category)) {
      throw new BadRequestException('Offering category is not part of the supplier profile');
    }
    const offering: ServiceOffering = {
      id: newId('offering'),
      supplierId: input.supplierId,
      category: input.category,
      title: input.title,
      description: input.description ?? '',
      priceNaira: input.priceNaira,
      pricingUnit: input.pricingUnit,
      isActive: true,
      createdAt: new Date().toISOString()
    };
    const created = await this.offerings.create(offering);
    await this.domainEvents.publish(
      'services.offering.created',
      { offeringId: created.id, supplierId: input.supplierId },
      actor.id
    );
    return created;
  }

  // -- Bookings ------------------------------------------------------------------

  async createBooking(input: CreateBookingInput): Promise<ServiceBooking> {
    const offering = await this.offerings.getById(input.offeringId);
    if (!offering.isActive) {
      throw new ConflictException('Offering is not accepting bookings');
    }
    if (input.scheduledEnd <= input.scheduledStart) {
      throw new BadRequestException('scheduledEnd must be after scheduledStart');
    }
    await this.assertNoWindowConflict(offering, input.scheduledStart, input.scheduledEnd);
    const booking: ServiceBooking = {
      id: newId('booking'),
      offeringId: input.offeringId,
      supplierId: offering.supplierId,
      customerId: input.customerId,
      quantity: input.quantity ?? 1,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      status: 'requested',
      notes: input.notes,
      createdAt: new Date().toISOString()
    };
    const created = await this.bookings.create(booking);
    await this.domainEvents.publish(
      'services.booking.requested',
      { bookingId: created.id, offeringId: input.offeringId },
      input.customerId
    );
    return created;
  }

  async getBooking(id: string): Promise<ServiceBooking> {
    return this.bookings.getById(id);
  }

  async listBookings(filter: {
    supplierId?: string;
    customerId?: string;
    status?: BookingStatus;
  }): Promise<ServiceBooking[]> {
    return this.bookings.find(filter);
  }

  /** Own bookings for the `/service-bookings/mine` endpoint (ownership-scoped by user id). */
  async listBookingsForCustomer(customerId: string, status?: BookingStatus): Promise<ServiceBooking[]> {
    const bookings = await this.bookings.find({ customerId, status });
    return bookings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Supplier issues a quote (requested → quoted) with the total price. */
  async quoteBooking(id: string, totalNaira: number, actor: Actor): Promise<ServiceBooking> {
    const booking = await this.bookings.getById(id);
    await this.assertTransitionAllowed(booking, 'quoted', actor);
    const updated = await this.bookings.update(id, { status: 'quoted', totalNaira });
    await this.domainEvents.publish(
      'services.booking.status_changed',
      { bookingId: id, status: 'quoted' },
      actor.id
    );
    return updated;
  }

  async setBookingStatus(id: string, status: BookingStatus, actor: Actor): Promise<ServiceBooking> {
    const booking = await this.bookings.getById(id);
    if (status === 'quoted') {
      throw new BadRequestException('Use the quote endpoint so a total price is recorded');
    }
    if (status === booking.status) {
      return booking; // idempotent replay, no event
    }
    await this.assertTransitionAllowed(booking, status, actor);
    if (status === 'scheduled') {
      const offering = await this.offerings.getById(booking.offeringId);
      await this.assertNoWindowConflict(
        offering,
        booking.scheduledStart,
        booking.scheduledEnd,
        booking.id
      );
    }
    const updated = await this.bookings.update(id, { status });
    await this.domainEvents.publish(
      'services.booking.status_changed',
      { bookingId: id, status },
      actor.id
    );
    return updated;
  }

  private async assertTransitionAllowed(
    booking: ServiceBooking,
    target: BookingStatus,
    actor: Actor
  ): Promise<void> {
    if (!ALLOWED_TRANSITIONS[booking.status].includes(target)) {
      throw new BadRequestException(
        `Invalid booking transition from '${booking.status}' to '${target}'`
      );
    }
    if (actor.roles.includes('admin')) {
      return;
    }
    const party = await this.partyOf(booking, actor);
    if (!party || !TRANSITION_ACTORS[target].includes(party)) {
      throw new ForbiddenException('Only the entitled booking party may perform this transition');
    }
  }

  private async partyOf(booking: ServiceBooking, actor: Actor): Promise<BookingParty | undefined> {
    if (actor.id === booking.customerId) return 'customer';
    const supplier = await this.suppliers.findById(booking.supplierId);
    if (supplier && supplier.ownerUserId === actor.id) return 'supplier';
    return undefined;
  }

  private assertSupplierParty(supplier: ServiceSupplier, actor: Actor): void {
    if (actor.id !== supplier.ownerUserId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the supplier owner may perform this action');
    }
  }

  private async assertNoWindowConflict(
    offering: ServiceOffering,
    start: string,
    end: string,
    excludeBookingId?: string
  ): Promise<void> {
    if (!CONFLICT_CHECKED_CATEGORIES.includes(offering.category)) {
      return;
    }
    const overlapping = (await this.bookings.findOverlapping(offering.id, start, end)).filter(
      (booking) => booking.id !== excludeBookingId
    );
    if (overlapping.length > 0) {
      throw new ConflictException(
        'The requested date window conflicts with an existing booking for this resource'
      );
    }
  }

  // -- Reviews -------------------------------------------------------------------

  async reviewBooking(
    bookingId: string,
    authorId: string,
    rating: number,
    comment?: string
  ): Promise<ServiceReview> {
    const booking = await this.bookings.getById(bookingId);
    if (booking.status !== 'completed') {
      throw new BadRequestException('Only completed bookings can be reviewed');
    }
    if (booking.customerId !== authorId) {
      throw new ForbiddenException('Only the booking customer may leave a review');
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    if (await this.reviews.findOne({ bookingId })) {
      throw new ConflictException('This booking has already been reviewed');
    }
    const review: ServiceReview = {
      id: newId('review'),
      bookingId,
      supplierId: booking.supplierId,
      authorId,
      rating,
      comment,
      createdAt: new Date().toISOString()
    };
    const created = await this.reviews.create(review);
    await this.recomputeSupplierRating(booking.supplierId);
    await this.domainEvents.publish(
      'services.review.submitted',
      { reviewId: created.id, bookingId, supplierId: booking.supplierId },
      authorId
    );
    return created;
  }

  async listSupplierReviews(supplierId: string): Promise<ServiceReview[]> {
    await this.suppliers.getById(supplierId);
    return this.reviews.find({ supplierId });
  }

  private async recomputeSupplierRating(supplierId: string): Promise<void> {
    const all = await this.reviews.find({ supplierId });
    const average = all.length === 0 ? 0 : all.reduce((sum, r) => sum + r.rating, 0) / all.length;
    await this.suppliers.update(supplierId, {
      averageRating: Math.round(average * 100) / 100,
      ratingCount: all.length
    });
  }
}
