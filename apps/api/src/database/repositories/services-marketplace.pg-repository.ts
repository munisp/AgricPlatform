import type pg from 'pg';
import type { ServiceBooking, ServiceOffering, ServiceReview, ServiceSupplier } from '@agric-platform/shared';
import {
  arrayContains,
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  serviceBookingMapper,
  serviceOfferingMapper,
  serviceReviewMapper,
  serviceSupplierMapper
} from '../pg/row-mappers.js';
import type { ServiceBookingCriteria, ServiceBookingRepository } from './service-booking.repository.js';
import type { ServiceOfferingCriteria, ServiceOfferingRepository } from './service-offering.repository.js';
import type { ServiceReviewCriteria, ServiceReviewRepository } from './service-review.repository.js';
import type { SupplierCriteria, SupplierRepository } from './supplier.repository.js';

export function supplierCriteriaSql(criteria: SupplierCriteria): WhereClause {
  return composeWhere(
    arrayContains('categories', criteria.category),
    arrayContains('states_covered', criteria.state),
    eq('verification_status', criteria.verificationStatus),
    eq('owner_user_id', criteria.ownerUserId)
  );
}

export class PgSupplierRepository
  extends PgRepositoryBase<ServiceSupplier, SupplierCriteria>
  implements SupplierRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'services.suppliers',
      mapper: serviceSupplierMapper,
      criteria: supplierCriteriaSql
    });
  }
}

export function serviceOfferingCriteriaSql(criteria: ServiceOfferingCriteria): WhereClause {
  return composeWhere(
    eq('supplier_id', criteria.supplierId),
    eq('category', criteria.category),
    eq('is_active', criteria.active)
  );
}

export class PgServiceOfferingRepository
  extends PgRepositoryBase<ServiceOffering, ServiceOfferingCriteria>
  implements ServiceOfferingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'services.offerings',
      mapper: serviceOfferingMapper,
      criteria: serviceOfferingCriteriaSql
    });
  }
}

export function serviceBookingCriteriaSql(criteria: ServiceBookingCriteria): WhereClause {
  return composeWhere(
    eq('offering_id', criteria.offeringId),
    eq('supplier_id', criteria.supplierId),
    eq('customer_id', criteria.customerId),
    eq('status', criteria.status)
  );
}

export class PgServiceBookingRepository
  extends PgRepositoryBase<ServiceBooking, ServiceBookingCriteria>
  implements ServiceBookingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'services.bookings',
      mapper: serviceBookingMapper,
      criteria: serviceBookingCriteriaSql
    });
  }

  async findOverlapping(offeringId: string, start: string, end: string): Promise<ServiceBooking[]> {
    const result = await this.pool.query(
      `SELECT ${serviceBookingMapper.columns.join(', ')} FROM services.bookings
        WHERE offering_id = $1
          AND status NOT IN ('declined', 'cancelled')
          AND scheduled_start < $3
          AND scheduled_end > $2
        ORDER BY id`,
      [offeringId, start, end]
    );
    return result.rows.map((row) => serviceBookingMapper.fromRow(row));
  }
}

export function serviceReviewCriteriaSql(criteria: ServiceReviewCriteria): WhereClause {
  return composeWhere(
    eq('booking_id', criteria.bookingId),
    eq('supplier_id', criteria.supplierId),
    eq('author_id', criteria.authorId)
  );
}

export class PgServiceReviewRepository
  extends PgRepositoryBase<ServiceReview, ServiceReviewCriteria>
  implements ServiceReviewRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'services.reviews',
      mapper: serviceReviewMapper,
      criteria: serviceReviewCriteriaSql
    });
  }
}

export function createPgSupplierRepository(pool: pg.Pool): PgSupplierRepository {
  return new PgSupplierRepository(pool);
}

export function createPgServiceOfferingRepository(pool: pg.Pool): PgServiceOfferingRepository {
  return new PgServiceOfferingRepository(pool);
}

export function createPgServiceBookingRepository(pool: pg.Pool): PgServiceBookingRepository {
  return new PgServiceBookingRepository(pool);
}

export function createPgServiceReviewRepository(pool: pg.Pool): PgServiceReviewRepository {
  return new PgServiceReviewRepository(pool);
}
