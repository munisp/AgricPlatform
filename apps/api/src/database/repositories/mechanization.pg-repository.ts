import type pg from 'pg';
import type { EquipmentBooking, EquipmentListing } from '@agric-platform/shared';
import {
  arrayContains,
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { equipmentBookingMapper, equipmentListingMapper } from '../pg/row-mappers.js';
import type {
  EquipmentBookingCriteria,
  EquipmentBookingRepository,
  EquipmentListingCriteria,
  EquipmentListingRepository
} from './mechanization.repository.js';
import { SCHEDULE_HOLDING_STATUSES } from './mechanization.repository.js';

export function equipmentListingCriteriaSql(criteria: EquipmentListingCriteria): WhereClause {
  return composeWhere(
    eq('owner_user_id', criteria.ownerUserId),
    eq('type', criteria.type),
    eq('status', criteria.status),
    eq('operator_verification', criteria.operatorVerification),
    arrayContains('service_area_h3', criteria.h3Cell)
  );
}

export class PgEquipmentListingRepository
  extends PgRepositoryBase<EquipmentListing, EquipmentListingCriteria>
  implements EquipmentListingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'mechanization.equipment_listings',
      mapper: equipmentListingMapper,
      criteria: equipmentListingCriteriaSql
    });
  }
}

export function equipmentBookingCriteriaSql(criteria: EquipmentBookingCriteria): WhereClause {
  return composeWhere(
    eq('listing_id', criteria.listingId),
    eq('owner_user_id', criteria.ownerUserId),
    eq('farmer_id', criteria.farmerId),
    eq('status', criteria.status)
  );
}

export class PgEquipmentBookingRepository
  extends PgRepositoryBase<EquipmentBooking, EquipmentBookingCriteria>
  implements EquipmentBookingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'mechanization.equipment_bookings',
      mapper: equipmentBookingMapper,
      criteria: equipmentBookingCriteriaSql
    });
  }

  async findOverlapping(
    listingId: string,
    start: string,
    end: string
  ): Promise<EquipmentBooking[]> {
    const result = await this.pool.query(
      `SELECT ${equipmentBookingMapper.columns.join(', ')} FROM mechanization.equipment_bookings
        WHERE listing_id = $1
          AND status = ANY ($2)
          AND window_start < $4
          AND window_end > $3
        ORDER BY id`,
      [listingId, [...SCHEDULE_HOLDING_STATUSES], start, end]
    );
    return result.rows.map((row) => equipmentBookingMapper.fromRow(row));
  }
}

export function createPgEquipmentListingRepository(pool: pg.Pool): PgEquipmentListingRepository {
  return new PgEquipmentListingRepository(pool);
}

export function createPgEquipmentBookingRepository(pool: pg.Pool): PgEquipmentBookingRepository {
  return new PgEquipmentBookingRepository(pool);
}
