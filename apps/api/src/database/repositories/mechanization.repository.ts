import type {
  EquipmentListing,
  EquipmentBooking,
  EquipmentListingStatus,
  EquipmentType,
  MechBookingStatus,
  OperatorVerificationStatus
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface EquipmentListingCriteria {
  ownerUserId?: string;
  type?: EquipmentType;
  status?: EquipmentListingStatus;
  operatorVerification?: OperatorVerificationStatus;
  /** Listings whose service area contains this H3 cell. */
  h3Cell?: string;
}

export type EquipmentListingRepository = AsyncRepository<
  EquipmentListing,
  EquipmentListingCriteria
>;

export function equipmentListingMatcher(
  criteria: EquipmentListingCriteria
): (listing: EquipmentListing) => boolean {
  return (listing) =>
    (!criteria.ownerUserId || listing.ownerUserId === criteria.ownerUserId) &&
    (!criteria.type || listing.type === criteria.type) &&
    (!criteria.status || listing.status === criteria.status) &&
    (!criteria.operatorVerification ||
      listing.operatorVerification === criteria.operatorVerification) &&
    (!criteria.h3Cell || listing.serviceAreaH3.includes(criteria.h3Cell));
}

export class InMemoryEquipmentListingRepository
  extends InMemoryRepository<EquipmentListing, EquipmentListingCriteria>
  implements EquipmentListingRepository
{
  constructor(seed: readonly EquipmentListing[] = []) {
    super(seed, equipmentListingMatcher);
  }
}

export function createInMemoryEquipmentListingRepository(): InMemoryEquipmentListingRepository {
  return new InMemoryEquipmentListingRepository();
}

export interface EquipmentBookingCriteria {
  listingId?: string;
  ownerUserId?: string;
  farmerId?: string;
  status?: MechBookingStatus;
}

export interface EquipmentBookingRepository
  extends AsyncRepository<EquipmentBooking, EquipmentBookingCriteria> {
  /**
   * Bookings holding the equipment schedule (confirmed / in_service) whose
   * [windowStart, windowEnd) overlaps [start, end). Travel buffers are
   * applied by the caller (they depend on each booking's plot distance).
   */
  findOverlapping(listingId: string, start: string, end: string): Promise<EquipmentBooking[]>;
}

export function equipmentBookingMatcher(
  criteria: EquipmentBookingCriteria
): (booking: EquipmentBooking) => boolean {
  return (booking) =>
    (!criteria.listingId || booking.listingId === criteria.listingId) &&
    (!criteria.ownerUserId || booking.ownerUserId === criteria.ownerUserId) &&
    (!criteria.farmerId || booking.farmerId === criteria.farmerId) &&
    (!criteria.status || booking.status === criteria.status);
}

/** Statuses that reserve the equipment schedule. */
export const SCHEDULE_HOLDING_STATUSES: readonly MechBookingStatus[] = ['confirmed', 'in_service'];

export class InMemoryEquipmentBookingRepository
  extends InMemoryRepository<EquipmentBooking, EquipmentBookingCriteria>
  implements EquipmentBookingRepository
{
  constructor(seed: readonly EquipmentBooking[] = []) {
    super(seed, equipmentBookingMatcher);
  }

  async findOverlapping(
    listingId: string,
    start: string,
    end: string
  ): Promise<EquipmentBooking[]> {
    const bookings = await this.find({ listingId });
    return bookings
      .filter(
        (booking) =>
          SCHEDULE_HOLDING_STATUSES.includes(booking.status) &&
          booking.windowStart < end &&
          booking.windowEnd > start
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function createInMemoryEquipmentBookingRepository(): InMemoryEquipmentBookingRepository {
  return new InMemoryEquipmentBookingRepository();
}
