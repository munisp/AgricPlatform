import type { BookingStatus, ServiceBooking } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ServiceBookingCriteria {
  offeringId?: string;
  supplierId?: string;
  customerId?: string;
  status?: BookingStatus;
}

export interface ServiceBookingRepository
  extends AsyncRepository<ServiceBooking, ServiceBookingCriteria> {
  /**
   * Non-terminal bookings for the offering whose [scheduledStart, scheduledEnd)
   * window overlaps [start, end). Used by the machinery/cold-storage conflict
   * guard.
   */
  findOverlapping(offeringId: string, start: string, end: string): Promise<ServiceBooking[]>;
}

export function serviceBookingMatcher(
  criteria: ServiceBookingCriteria
): (booking: ServiceBooking) => boolean {
  return (booking) =>
    (!criteria.offeringId || booking.offeringId === criteria.offeringId) &&
    (!criteria.supplierId || booking.supplierId === criteria.supplierId) &&
    (!criteria.customerId || booking.customerId === criteria.customerId) &&
    (!criteria.status || booking.status === criteria.status);
}

const OVERLAP_EXCLUDED_STATUSES: readonly BookingStatus[] = ['declined', 'cancelled'];

export class InMemoryServiceBookingRepository
  extends InMemoryRepository<ServiceBooking, ServiceBookingCriteria>
  implements ServiceBookingRepository
{
  constructor(seed: readonly ServiceBooking[] = []) {
    super(seed, serviceBookingMatcher);
  }

  async findOverlapping(offeringId: string, start: string, end: string): Promise<ServiceBooking[]> {
    const bookings = await this.find({ offeringId });
    return bookings.filter(
      (booking) =>
        !OVERLAP_EXCLUDED_STATUSES.includes(booking.status) &&
        booking.scheduledStart < end &&
        booking.scheduledEnd > start
    );
  }
}

export function createInMemoryServiceBookingRepository(): InMemoryServiceBookingRepository {
  return new InMemoryServiceBookingRepository();
}
