import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type {
  AvailabilityWindow,
  EquipmentBooking,
  EquipmentListing,
  EquipmentListingStatus,
  EquipmentOwnerType,
  EquipmentRates,
  EquipmentType,
  MechAdvisory,
  MechBookingStatus,
  OperatorVerificationStatus,
  OwnerUtilizationStats,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  EQUIPMENT_BOOKING_REPOSITORY,
  EQUIPMENT_LISTING_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  EquipmentBookingRepository,
  EquipmentListingRepository
} from '../../database/repositories/mechanization.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { GeoIntelService } from '../geo-intel/geo-intel.service.js';
import { cancellationSplit, type CancellingParty } from './cancellation.js';
import { computeQuote, haversineKm } from './pricing.js';
import {
  bufferedWindow,
  findConflicts,
  MAX_TRAVEL_BUFFER_MS,
  suggestFreeWindows,
  withinAvailability
} from './scheduling.js';

/** Grace period after windowEnd before an in_service booking auto-completes. */
export const AUTO_COMPLETE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Ledger accounts (stub execution mode — no real charges; see docs). */
export const MECH_HOLDS_ACCOUNT = 'platform:mechanization_holds';
export const walletAccount = (userId: string): string => `member:${userId}:wallet`;

type Actor = Pick<User, 'id' | 'roles'>;
type Party = 'farmer' | 'owner';

/** Booking state machine. Terminal: completed→rated, cancelled. */
export const MECH_TRANSITIONS: Readonly<Record<MechBookingStatus, readonly MechBookingStatus[]>> = {
  requested: ['quoted', 'cancelled'],
  quoted: ['confirmed', 'cancelled'],
  confirmed: ['in_service', 'cancelled', 'disputed'],
  in_service: ['completed', 'disputed', 'cancelled'],
  completed: ['rated'],
  rated: [],
  cancelled: [],
  disputed: ['completed', 'cancelled'] // admin resolution only
};

/** Which party may drive each transition target (admin always may). */
const TRANSITION_ACTORS: Readonly<Record<MechBookingStatus, readonly Party[]>> = {
  requested: [],
  quoted: ['owner'],
  confirmed: ['farmer'],
  in_service: ['owner'],
  completed: ['farmer', 'owner'], // second completion confirmation
  rated: ['farmer'],
  cancelled: ['farmer', 'owner'],
  disputed: ['farmer', 'owner']
};

export interface CreateListingInput {
  ownerUserId: string;
  ownerType: EquipmentOwnerType;
  type: EquipmentType;
  title: string;
  description?: string;
  specs?: Record<string, unknown>;
  baseLat: number;
  baseLong: number;
  /** H3 resolution for the service area (5–7). */
  serviceAreaResolution: number;
  /** k-ring around the base cell that the owner serves (0 = base cell only). */
  serviceAreaRing: number;
  rates: EquipmentRates;
  availability: AvailabilityWindow[];
  operatorLicenseRef?: string;
}

export interface CreateBookingInput {
  farmerId: string;
  plotId?: string;
  plotLat: number;
  plotLong: number;
  areaHa: number;
  estimatedHours?: number;
  windowStart: string;
  windowEnd: string;
}

export interface BrowseListingsFilter {
  type?: EquipmentType;
  h3Cell?: string;
  lat?: number;
  long?: number;
  availableFrom?: string;
  availableTo?: string;
}

@Injectable()
export class MechanizationService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly h3: H3Service,
    private readonly ledger: LedgerService,
    @Inject(EQUIPMENT_LISTING_REPOSITORY) private readonly listings: EquipmentListingRepository,
    @Inject(EQUIPMENT_BOOKING_REPOSITORY) private readonly bookings: EquipmentBookingRepository,
    @Optional() private readonly geoIntel?: GeoIntelService,
    @Optional() private readonly audit?: AuditService
  ) {}

  // -- Listings ---------------------------------------------------------------

  async createListing(input: CreateListingInput, actorId: string): Promise<EquipmentListing> {
    this.h3.assertCoordinates(input.baseLat, input.baseLong);
    if (!Number.isInteger(input.serviceAreaResolution) || input.serviceAreaResolution < 5 || input.serviceAreaResolution > 7) {
      throw new BadRequestException('serviceAreaResolution must be an integer between 5 and 7');
    }
    const hasPerHa = typeof input.rates?.perHaNaira === 'number' && input.rates.perHaNaira > 0;
    const hasPerHour = typeof input.rates?.perHourNaira === 'number' && input.rates.perHourNaira > 0;
    if (!hasPerHa && !hasPerHour) {
      throw new BadRequestException('rates must carry a positive perHaNaira and/or perHourNaira');
    }
    if ((input.rates.perKmNaira ?? 0) < 0 || (input.rates.includedKm ?? 0) < 0) {
      throw new BadRequestException('perKmNaira and includedKm must be non-negative');
    }
    this.assertAvailability(input.availability);
    const centerCell = this.h3.cellAt(input.baseLat, input.baseLong, input.serviceAreaResolution);
    const serviceAreaH3 = this.h3.disk(centerCell, input.serviceAreaRing).sort();
    const now = new Date().toISOString();
    const listing: EquipmentListing = {
      id: newId('mechlisting'),
      ownerUserId: input.ownerUserId,
      ownerType: input.ownerType,
      type: input.type,
      title: input.title,
      description: input.description ?? '',
      specs: input.specs ?? {},
      baseLat: input.baseLat,
      baseLong: input.baseLong,
      serviceAreaH3,
      serviceAreaResolution: input.serviceAreaResolution,
      rates: {
        ...(hasPerHa ? { perHaNaira: input.rates.perHaNaira } : {}),
        ...(hasPerHour ? { perHourNaira: input.rates.perHourNaira } : {}),
        perKmNaira: input.rates.perKmNaira ?? 0,
        includedKm: input.rates.includedKm ?? 0
      },
      availability: input.availability,
      operatorLicenseRef: input.operatorLicenseRef,
      operatorVerification: 'pending',
      status: 'draft',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.listings.create(listing);
    await this.events.publish(
      'mechanization.listing.created',
      { listingId: created.id, ownerUserId: created.ownerUserId, type: created.type },
      actorId
    );
    return created;
  }

  async browseListings(filter: BrowseListingsFilter): Promise<EquipmentListing[]> {
    let h3Cell = filter.h3Cell;
    if (!h3Cell && filter.lat !== undefined && filter.long !== undefined) {
      // Browse matches at res 5 (coarsest service-area resolution).
      h3Cell = this.h3.cellAt(filter.lat, filter.long, 5);
    }
    const listings = await this.listings.find({ type: filter.type, status: 'active', h3Cell });
    if (filter.availableFrom && filter.availableTo) {
      return listings.filter((listing) =>
        listing.availability.some(
          (window) =>
            window.start < filter.availableTo! && window.end > filter.availableFrom!
        )
      );
    }
    return listings;
  }

  async listOwnerListings(ownerUserId: string): Promise<EquipmentListing[]> {
    return this.listings.find({ ownerUserId });
  }

  async getListing(id: string): Promise<EquipmentListing> {
    return this.listings.getById(id);
  }

  /** DRAFT→ACTIVE→PAUSED lifecycle; ACTIVE requires a VERIFIED operator. */
  async setListingStatus(
    id: string,
    status: EquipmentListingStatus,
    actor: Actor
  ): Promise<EquipmentListing> {
    const listing = await this.listings.getById(id);
    this.assertOwner(listing, actor);
    if (listing.status === status) {
      return listing; // idempotent replay
    }
    const allowed: Readonly<Record<EquipmentListingStatus, readonly EquipmentListingStatus[]>> = {
      draft: ['active'],
      active: ['paused'],
      paused: ['active']
    };
    if (!allowed[listing.status].includes(status)) {
      throw new BadRequestException(
        `Invalid listing transition from '${listing.status}' to '${status}'`
      );
    }
    if (status === 'active' && listing.operatorVerification !== 'verified') {
      throw new ConflictException(
        'Listing cannot go active until the operator licence is verified (admin action)'
      );
    }
    const updated = await this.listings.update(id, { status, updatedAt: new Date().toISOString() });
    await this.events.publish(
      'mechanization.listing.status_changed',
      { listingId: id, status },
      actor.id
    );
    return updated;
  }

  /** Admin-only operator licence verification (controller guards the role). */
  async setOperatorVerification(
    id: string,
    operatorVerification: OperatorVerificationStatus,
    actorId: string
  ): Promise<EquipmentListing> {
    await this.listings.getById(id);
    const updated = await this.listings.update(id, {
      operatorVerification,
      updatedAt: new Date().toISOString()
    });
    await this.audit?.record({
      actorId,
      action: 'mechanization.operator.verification_changed',
      entityType: 'equipment_listing',
      entityId: id,
      metadata: { operatorVerification }
    });
    await this.events.publish(
      'mechanization.operator.verification_changed',
      { listingId: id, operatorVerification },
      actorId
    );
    return updated;
  }

  // -- Bookings ---------------------------------------------------------------

  async requestBooking(listingId: string, input: CreateBookingInput): Promise<EquipmentBooking> {
    const listing = await this.listings.getById(listingId);
    if (listing.status !== 'active') {
      throw new ConflictException(`Listing is not accepting bookings (status '${listing.status}')`);
    }
    if (Date.parse(input.windowEnd) <= Date.parse(input.windowStart)) {
      throw new BadRequestException('windowEnd must be after windowStart');
    }
    if (!Number.isFinite(input.areaHa) || input.areaHa <= 0) {
      throw new BadRequestException('areaHa must be a positive number');
    }
    if (listing.rates.perHourNaira && (!input.estimatedHours || input.estimatedHours <= 0)) {
      throw new BadRequestException('estimatedHours is required for per-hour listings');
    }
    const plotH3 = this.h3.cellAt(input.plotLat, input.plotLong, listing.serviceAreaResolution);
    if (!listing.serviceAreaH3.includes(plotH3)) {
      throw new BadRequestException('The plot falls outside this listing\'s service area');
    }
    if (!withinAvailability(input.windowStart, input.windowEnd, listing.availability)) {
      throw new BadRequestException('The requested window is outside the listing\'s availability');
    }
    const now = new Date().toISOString();
    const booking: EquipmentBooking = {
      id: newId('mechbooking'),
      listingId,
      ownerUserId: listing.ownerUserId,
      farmerId: input.farmerId,
      plotId: input.plotId,
      plotLat: input.plotLat,
      plotLong: input.plotLong,
      plotH3,
      areaHa: input.areaHa,
      estimatedHours: input.estimatedHours,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      status: 'requested',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.bookings.create(booking);
    await this.events.publish(
      'mechanization.booking.requested',
      { bookingId: created.id, listingId, farmerId: input.farmerId },
      input.farmerId
    );
    return created;
  }

  async getBooking(id: string): Promise<EquipmentBooking> {
    return this.bookings.getById(id);
  }

  async listBookingsForFarmer(farmerId: string): Promise<EquipmentBooking[]> {
    const bookings = await this.bookings.find({ farmerId });
    return bookings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listBookingsForOwner(ownerUserId: string, status?: MechBookingStatus): Promise<EquipmentBooking[]> {
    const bookings = await this.bookings.find({ ownerUserId, status });
    return bookings.sort((a, b) => a.windowStart.localeCompare(b.windowStart));
  }

  /** Owner accepts a request: computes the price and attaches any flood advisory. */
  async quoteBooking(id: string, actor: Actor): Promise<EquipmentBooking> {
    const booking = await this.bookings.getById(id);
    await this.assertTransitionAllowed(booking, 'quoted', actor);
    const listing = await this.listings.getById(booking.listingId);
    await this.assertNoScheduleConflict(listing, booking);
    const distanceKm = haversineKm(
      listing.baseLat,
      listing.baseLong,
      booking.plotLat,
      booking.plotLong
    );
    let quote: EquipmentBooking['quote'];
    try {
      quote = computeQuote({
        rates: listing.rates,
        areaHa: booking.areaHa,
        estimatedHours: booking.estimatedHours,
        distanceKm,
        windowStart: booking.windowStart
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? `Cannot quote this booking: ${error.message}` : 'Cannot quote'
      );
    }
    if (!quote) {
      throw new BadRequestException('Cannot quote this booking');
    }
    const advisory = await this.buildAdvisory(booking);
    const updated = await this.bookings.update(id, {
      status: 'quoted',
      quote,
      advisory,
      updatedAt: new Date().toISOString()
    });
    await this.events.publish(
      'mechanization.booking.quoted',
      { bookingId: id, totalKobo: quote.totalKobo, advisorySevere: advisory?.severe ?? false },
      actor.id
    );
    return updated;
  }

  /**
   * Farmer accepts the quote: payment HOLD via the finance ledger (stub
   * execution mode — the double-entry hold is the system of record; no real
   * charge). Idempotent per booking via the hold idempotency key.
   */
  async confirmBooking(id: string, actor: Actor): Promise<EquipmentBooking> {
    const booking = await this.bookings.getById(id);
    if (booking.status === 'confirmed') {
      return booking; // idempotent replay of a confirm retry
    }
    await this.assertTransitionAllowed(booking, 'confirmed', actor);
    if (!booking.quote) {
      throw new BadRequestException('Booking has no quote to confirm');
    }
    const listing = await this.listings.getById(booking.listingId);
    await this.assertNoScheduleConflict(listing, booking);
    const entry = await this.postHold(booking, actor.id);
    const updated = await this.bookings.update(id, {
      status: 'confirmed',
      holdEntryId: entry.id,
      updatedAt: new Date().toISOString()
    });
    await this.events.publish(
      'mechanization.booking.confirmed',
      { bookingId: id, holdEntryId: entry.id, totalKobo: booking.quote.totalKobo },
      actor.id
    );
    return updated;
  }

  /** Owner marks the equipment deployed (confirmed → in_service). */
  async startService(id: string, actor: Actor): Promise<EquipmentBooking> {
    const booking = await this.bookings.getById(id);
    await this.assertTransitionAllowed(booking, 'in_service', actor);
    return this.transitionTo(booking, 'in_service', actor.id);
  }

  /**
   * Completion needs BOTH parties: each confirmation is recorded; the second
   * one moves the booking to completed and releases the hold to the owner.
   */
  async confirmCompletion(id: string, actor: Actor): Promise<EquipmentBooking> {
    const booking = await this.bookings.getById(id);
    if (booking.status !== 'in_service') {
      if (booking.status === 'completed' || booking.status === 'rated') {
        return booking; // idempotent replay
      }
      throw new BadRequestException(
        `Only in-service bookings can be completed (status '${booking.status}')`
      );
    }
    const party = await this.partyOf(booking, actor);
    if (!party && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only a booking party may confirm completion');
    }
    const now = new Date().toISOString();
    const patch: Partial<EquipmentBooking> = { updatedAt: now };
    if (party === 'farmer') patch.farmerConfirmedCompletionAt = now;
    if (party === 'owner') patch.ownerConfirmedCompletionAt = now;
    if (actor.roles.includes('admin') && !party) {
      patch.farmerConfirmedCompletionAt = patch.farmerConfirmedCompletionAt ?? now;
      patch.ownerConfirmedCompletionAt = patch.ownerConfirmedCompletionAt ?? now;
    }
    const merged = { ...booking, ...patch };
    if (!merged.farmerConfirmedCompletionAt || !merged.ownerConfirmedCompletionAt) {
      return this.bookings.update(id, patch); // first confirmation only
    }
    const completed = await this.transitionTo(merged, 'completed', actor.id, patch);
    await this.releaseHold(completed, 'pay_owner', actor.id);
    return completed;
  }

  /** Cancellation with the deterministic hold-release schedule. */
  async cancelBooking(id: string, actor: Actor, reason?: string): Promise<EquipmentBooking> {
    const booking = await this.bookings.getById(id);
    if (booking.status === 'cancelled') {
      return booking; // idempotent replay
    }
    await this.assertTransitionAllowed(booking, 'cancelled', actor);
    const party = await this.partyOf(booking, actor);
    const cancelledBy: CancellingParty = actor.roles.includes('admin') && !party ? 'admin' : (party as CancellingParty);
    const updated = await this.transitionTo(booking, 'cancelled', actor.id, {
      cancelledBy,
      cancelReason: reason
    });
    if (booking.holdEntryId && booking.quote) {
      const split = cancellationSplit(
        booking.quote.totalKobo,
        cancelledBy,
        booking.windowStart,
        Date.now()
      );
      await this.releaseHoldSplit(updated, split.refundToFarmerKobo, split.compensationToOwnerKobo, actor.id);
      await this.audit?.record({
        actorId: actor.id,
        action: 'mechanization.hold.released',
        entityType: 'equipment_booking',
        entityId: id,
        metadata: { cancelledBy, ...split }
      });
    }
    await this.events.publish(
      'mechanization.booking.cancelled',
      { bookingId: id, cancelledBy },
      actor.id
    );
    return updated;
  }

  /** Either party may freeze the hold by disputing (confirmed/in_service). */
  async disputeBooking(id: string, actor: Actor, reason?: string): Promise<EquipmentBooking> {
    const booking = await this.bookings.getById(id);
    await this.assertTransitionAllowed(booking, 'disputed', actor);
    const updated = await this.transitionTo(booking, 'disputed', actor.id, {
      cancelReason: reason
    });
    await this.events.publish('mechanization.booking.disputed', { bookingId: id }, actor.id);
    return updated;
  }

  /** Admin dispute resolution: the frozen hold pays out 100% one way. */
  async resolveDispute(
    id: string,
    outcome: 'refund_farmer' | 'pay_owner',
    actor: Actor
  ): Promise<EquipmentBooking> {
    if (!actor.roles.includes('admin')) {
      throw new ForbiddenException('Only an administrator may resolve a dispute');
    }
    const booking = await this.bookings.getById(id);
    if (booking.status !== 'disputed') {
      throw new BadRequestException(`Only disputed bookings can be resolved (status '${booking.status}')`);
    }
    const target: MechBookingStatus = outcome === 'refund_farmer' ? 'cancelled' : 'completed';
    const updated = await this.transitionTo(booking, target, actor.id, {
      cancelledBy: outcome === 'refund_farmer' ? 'admin' : undefined
    });
    if (booking.holdEntryId) {
      await this.releaseHold(updated, outcome, actor.id);
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'mechanization.dispute.resolved',
      entityType: 'equipment_booking',
      entityId: id,
      metadata: { outcome }
    });
    return updated;
  }

  /** Farmer rates a completed booking (completed → rated). */
  async rateBooking(
    id: string,
    actor: Actor,
    rating: number,
    comment?: string
  ): Promise<EquipmentBooking> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    const booking = await this.bookings.getById(id);
    if (booking.farmerId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the booking farmer may rate');
    }
    await this.assertTransitionAllowed(booking, 'rated', { id: booking.farmerId, roles: [] });
    const updated = await this.transitionTo(booking, 'rated', actor.id, {
      rating,
      reviewComment: comment
    });
    await this.events.publish(
      'mechanization.booking.rated',
      { bookingId: id, listingId: booking.listingId, rating },
      actor.id
    );
    return updated;
  }

  /**
   * Deterministic auto-completion sweep: in_service bookings whose window
   * ended more than AUTO_COMPLETE_GRACE_MS ago complete and pay the owner.
   * Safe to re-run — completed bookings are no longer in_service.
   */
  async autoCompleteExpired(now: string = new Date().toISOString()): Promise<EquipmentBooking[]> {
    const cutoff = Date.parse(now) - AUTO_COMPLETE_GRACE_MS;
    const inService = await this.bookings.find({ status: 'in_service' });
    const completed: EquipmentBooking[] = [];
    for (const booking of inService) {
      if (Date.parse(booking.windowEnd) > cutoff) {
        continue;
      }
      const done = await this.transitionTo(booking, 'completed', 'system', {
        farmerConfirmedCompletionAt: booking.farmerConfirmedCompletionAt ?? now,
        ownerConfirmedCompletionAt: booking.ownerConfirmedCompletionAt ?? now
      });
      if (booking.holdEntryId) {
        await this.releaseHold(done, 'pay_owner', 'system');
      }
      completed.push(done);
    }
    return completed;
  }

  /** Utilization rollup — derived from bookings, never stored counters. */
  async utilizationStats(ownerUserId: string): Promise<OwnerUtilizationStats> {
    const listings = await this.listings.find({ ownerUserId });
    const bookings = await this.bookings.find({ ownerUserId });
    let bookedHours = 0;
    let revenueClearedKobo = 0;
    let completedBookings = 0;
    let cancelledBookings = 0;
    let disputedBookings = 0;
    for (const booking of bookings) {
      if (booking.status === 'confirmed' || booking.status === 'in_service' || booking.status === 'completed' || booking.status === 'rated') {
        bookedHours += (Date.parse(booking.windowEnd) - Date.parse(booking.windowStart)) / 3_600_000;
      }
      if (booking.status === 'completed' || booking.status === 'rated') {
        completedBookings += 1;
        revenueClearedKobo += booking.quote?.totalKobo ?? 0;
      } else if (booking.status === 'cancelled') {
        cancelledBookings += 1;
      } else if (booking.status === 'disputed') {
        disputedBookings += 1;
      }
    }
    const terminal = completedBookings + cancelledBookings + disputedBookings;
    return {
      ownerUserId,
      listingCount: listings.length,
      bookedHours: Math.round(bookedHours * 100) / 100,
      completedBookings,
      cancelledBookings,
      disputedBookings,
      completionRate: terminal === 0 ? 0 : Math.round((completedBookings / terminal) * 1000) / 1000,
      revenueClearedKobo
    };
  }

  // -- internals ----------------------------------------------------------------

  private assertAvailability(availability: AvailabilityWindow[]): void {
    if (!Array.isArray(availability) || availability.length === 0) {
      throw new BadRequestException('At least one availability window is required');
    }
    for (const window of availability) {
      if (Number.isNaN(Date.parse(window.start)) || Number.isNaN(Date.parse(window.end))) {
        throw new BadRequestException('Availability windows must be ISO 8601 instants');
      }
      if (Date.parse(window.end) <= Date.parse(window.start)) {
        throw new BadRequestException('Availability window end must be after its start');
      }
    }
  }

  private assertOwner(listing: EquipmentListing, actor: Actor): void {
    if (listing.ownerUserId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the listing owner may perform this action');
    }
  }

  private async partyOf(booking: EquipmentBooking, actor: Actor): Promise<Party | undefined> {
    if (actor.id === booking.farmerId) return 'farmer';
    if (actor.id === booking.ownerUserId) return 'owner';
    return undefined;
  }

  private async assertTransitionAllowed(
    booking: EquipmentBooking,
    target: MechBookingStatus,
    actor: Actor
  ): Promise<void> {
    // Entitlement is checked BEFORE state validity: non-parties must not be
    // able to probe the state machine (403 regardless of current status),
    // while entitled parties get precise 400 feedback on illegal jumps.
    if (!actor.roles.includes('admin')) {
      const party = await this.partyOf(booking, actor);
      if (!party || !TRANSITION_ACTORS[target].includes(party)) {
        throw new ForbiddenException('Only the entitled booking party may perform this transition');
      }
    }
    if (!MECH_TRANSITIONS[booking.status].includes(target)) {
      throw new BadRequestException(
        `Invalid booking transition from '${booking.status}' to '${target}'`
      );
    }
  }

  private async transitionTo(
    booking: EquipmentBooking,
    status: MechBookingStatus,
    actorId: string,
    extraPatch: Partial<EquipmentBooking> = {}
  ): Promise<EquipmentBooking> {
    const event = this.events.build(
      'mechanization.booking.status_changed',
      { bookingId: booking.id, from: booking.status, to: status },
      actorId
    );
    const updated = await this.bookings.updateExpected(
      booking.id,
      { ...extraPatch, status, updatedAt: new Date().toISOString() },
      { status: booking.status },
      event
    );
    if (this.bookings.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    return updated;
  }

  /**
   * Conflict guard: the candidate's buffered window must not clash with any
   * schedule-holding booking's buffered window. 409 carries deterministic
   * nearest-free-window suggestions.
   */
  private async assertNoScheduleConflict(
    listing: EquipmentListing,
    candidate: EquipmentBooking
  ): Promise<void> {
    const candidateDistance = haversineKm(
      listing.baseLat,
      listing.baseLong,
      candidate.plotLat,
      candidate.plotLong
    );
    // Query with bounds expanded by the maximum possible travel buffer on
    // each side — the repository overlap test is raw-window, but a booking
    // whose raw window merely comes close can still clash once buffers are
    // applied, and it must be fetched for findConflicts to see it.
    const queryStart = new Date(Date.parse(candidate.windowStart) - MAX_TRAVEL_BUFFER_MS).toISOString();
    const queryEnd = new Date(Date.parse(candidate.windowEnd) + MAX_TRAVEL_BUFFER_MS).toISOString();
    const overlapping = (await this.bookings.findOverlapping(
      listing.id,
      queryStart,
      queryEnd
    )).filter((booking) => booking.id !== candidate.id);
    if (overlapping.length === 0) {
      return;
    }
    const existing = overlapping.map((booking) => ({
      booking,
      distanceKm: haversineKm(listing.baseLat, listing.baseLong, booking.plotLat, booking.plotLong)
    }));
    const conflicts = findConflicts(
      bufferedWindow(candidate.windowStart, candidate.windowEnd, candidateDistance),
      existing
    );
    if (conflicts.length === 0) {
      return; // raw windows touch but travel buffers clear each other
    }
    const suggestions = suggestFreeWindows(
      candidate.windowStart,
      candidate.windowEnd,
      candidateDistance,
      listing.availability,
      existing
    );
    throw new ConflictException({
      message: 'The requested window conflicts with an existing booking for this equipment',
      conflictingBookingIds: conflicts.map((conflict) => conflict.booking.id),
      suggestedWindows: suggestions
    });
  }

  /** Ledger hold: farmer wallet → platform holds account (stub execution). */
  private async postHold(booking: EquipmentBooking, actorId: string) {
    const amountKobo = booking.quote!.totalKobo;
    await this.ledger.ensureAccount({ code: MECH_HOLDS_ACCOUNT, type: 'asset' });
    await this.ledger.ensureAccount({
      code: walletAccount(booking.farmerId),
      type: 'liability',
      ownerId: booking.farmerId
    });
    return this.ledger.postEntry(
      {
        idempotencyKey: `mech-hold:${booking.id}`,
        referenceType: 'equipment_booking',
        referenceId: booking.id,
        description: `Mechanization booking hold (${booking.id})`,
        postings: [
          { accountCode: MECH_HOLDS_ACCOUNT, direction: 'debit', amountKobo },
          { accountCode: walletAccount(booking.farmerId), direction: 'credit', amountKobo }
        ]
      },
      actorId
    );
  }

  /** Full release to one party (completion / dispute resolution). */
  private async releaseHold(
    booking: EquipmentBooking,
    outcome: 'refund_farmer' | 'pay_owner',
    actorId: string
  ): Promise<void> {
    const amountKobo = booking.quote?.totalKobo ?? 0;
    if (amountKobo <= 0) {
      return;
    }
    await this.releaseHoldSplit(
      booking,
      outcome === 'refund_farmer' ? amountKobo : 0,
      outcome === 'pay_owner' ? amountKobo : 0,
      actorId
    );
  }

  /** Split release (cancellation schedule). Exact conservation of kobo. */
  private async releaseHoldSplit(
    booking: EquipmentBooking,
    refundToFarmerKobo: number,
    compensationToOwnerKobo: number,
    actorId: string
  ): Promise<void> {
    const total = refundToFarmerKobo + compensationToOwnerKobo;
    if (total <= 0) {
      return;
    }
    await this.ledger.ensureAccount({
      code: walletAccount(booking.farmerId),
      type: 'liability',
      ownerId: booking.farmerId
    });
    await this.ledger.ensureAccount({
      code: walletAccount(booking.ownerUserId),
      type: 'liability',
      ownerId: booking.ownerUserId
    });
    const postings: { accountCode: string; direction: 'debit' | 'credit'; amountKobo: number }[] = [];
    if (refundToFarmerKobo > 0) {
      postings.push({
        accountCode: walletAccount(booking.farmerId),
        direction: 'debit',
        amountKobo: refundToFarmerKobo
      });
    }
    if (compensationToOwnerKobo > 0) {
      postings.push({
        accountCode: walletAccount(booking.ownerUserId),
        direction: 'debit',
        amountKobo: compensationToOwnerKobo
      });
    }
    postings.push({ accountCode: MECH_HOLDS_ACCOUNT, direction: 'credit', amountKobo: total });
    await this.ledger.postEntry(
      {
        idempotencyKey: `mech-release:${booking.id}`,
        referenceType: 'equipment_booking',
        referenceId: booking.id,
        description: `Mechanization hold release (${booking.id})`,
        postings,
        // The holds account can never pay out more than was held.
        requireSolventAccounts: [MECH_HOLDS_ACCOUNT]
      },
      actorId
    );
    await this.events.publish(
      'mechanization.hold.released',
      { bookingId: booking.id, refundToFarmerKobo, compensationToOwnerKobo },
      actorId
    );
  }

  /**
   * Optional weather-advisory hook (geo-intel flood port). Advisory only:
   * never blocks the quote, and the basis label always travels with the flag
   * so consumers know whether the assessment was live, stubbed or skipped.
   */
  private async buildAdvisory(booking: EquipmentBooking): Promise<MechAdvisory | undefined> {
    if (!this.geoIntel) {
      return { severe: false, basis: 'not-configured', h3Cell: booking.plotH3 };
    }
    try {
      const [lat, long] = this.h3.center(booking.plotH3);
      // System-context assessment for the booking plot; the geo-intel driver
      // port stays fail-closed (stub fixture by default, 503 when a live
      // sidecar is configured but unreachable) and we degrade honestly.
      const result = await this.geoIntel.assessFloodRisk(
        {
          id: booking.farmerId,
          phone: '',
          fullName: 'Mechanization advisory hook',
          roles: ['farmer'],
          preferredLanguage: 'en',
          kycTier: 'tier_0',
          isVerified: false,
          createdAt: booking.createdAt
        },
        { lat, long }
      );
      return {
        severe: result.severity === 'severe',
        basis: `${result.driver}:${result.source}`,
        severity: result.severity,
        h3Cell: booking.plotH3
      };
    } catch {
      return { severe: false, basis: 'unavailable:geo-intel', h3Cell: booking.plotH3 };
    }
  }
}
