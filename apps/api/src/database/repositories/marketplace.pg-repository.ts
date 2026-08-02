import { BadRequestException } from '@nestjs/common';
import type pg from 'pg';
import type { MarketplaceListing, Order } from '@agric-platform/shared';
import type { OrderReview } from '../seed-data.js';
import {
  composeWhere,
  eq,
  ilike,
  mapPgError,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { listingMapper, orderMapper, reviewMapper } from '../pg/row-mappers.js';
import type { ListingCriteria, ListingRepository } from './listing.repository.js';
import type { OrderCriteria, OrderRepository } from './order.repository.js';
import type { ReviewCriteria, ReviewRepository } from './review.repository.js';

export function listingCriteriaSql(criteria: ListingCriteria): WhereClause {
  return composeWhere(
    eq('kind', criteria.kind),
    eq('location_state', criteria.state),
    eq('crop', criteria.crop),
    criteria.active === undefined ? null : eq('is_active', criteria.active),
    ilike('title', criteria.q)
  );
}

export class PgListingRepository
  extends PgRepositoryBase<MarketplaceListing, ListingCriteria>
  implements ListingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.listings',
      mapper: listingMapper,
      criteria: listingCriteriaSql
    });
  }

  async activeListingCount(): Promise<number> {
    return this.count({ active: true });
  }
}

export function orderCriteriaSql(criteria: OrderCriteria): WhereClause {
  return composeWhere(
    eq('buyer_id', criteria.buyerId),
    eq('seller_id', criteria.sellerId),
    eq('status', criteria.status)
  );
}

const ORDER_COLUMNS = orderMapper.columns.join(', ');

export class PgOrderRepository
  extends PgRepositoryBase<Order, OrderCriteria>
  implements OrderRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.orders', mapper: orderMapper, criteria: orderCriteriaSql });
  }

  /**
   * Order placement in one transaction (plan §10.15): lock the listing row
   * FOR UPDATE, re-validate availability, then insert.
   */
  async placeOrder(order: Order): Promise<Order> {
    return this.withTransaction(async (client) => {
      const listing = await client.query(
        `SELECT seller_id, quantity, is_active FROM marketplace.listings WHERE id = $1 FOR UPDATE`,
        [order.listingId]
      );
      const row = listing.rows[0] as
        | { seller_id: string; quantity: string; is_active: boolean }
        | undefined;
      if (!row || !row.is_active) {
        throw new BadRequestException('Listing is not active');
      }
      if (order.quantity <= 0 || order.quantity > Number(row.quantity)) {
        throw new BadRequestException(`Quantity must be between 1 and ${row.quantity}`);
      }
      if (row.seller_id === order.buyerId) {
        throw new BadRequestException('Sellers cannot order their own listing');
      }
      const orderRow = orderMapper.toRow(order);
      const columns = Object.keys(orderRow);
      try {
        await client.query(
          `INSERT INTO marketplace.orders (${columns.join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          columns.map((column) => orderRow[column])
        );
      } catch (error) {
        mapPgError(error);
      }
      return order;
    });
  }
}

export function reviewCriteriaSql(criteria: ReviewCriteria): WhereClause {
  return composeWhere(eq('order_id', criteria.orderId));
}

export class PgReviewRepository
  extends PgRepositoryBase<OrderReview, ReviewCriteria>
  implements ReviewRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.reviews', mapper: reviewMapper, criteria: reviewCriteriaSql });
  }
}

export function createPgListingRepository(pool: pg.Pool): PgListingRepository {
  return new PgListingRepository(pool);
}

export function createPgOrderRepository(pool: pg.Pool): PgOrderRepository {
  return new PgOrderRepository(pool);
}

export function createPgReviewRepository(pool: pg.Pool): PgReviewRepository {
  return new PgReviewRepository(pool);
}
