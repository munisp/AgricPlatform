import { BadRequestException, NotFoundException } from '@nestjs/common';
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

  /** Atomic stock increment (Wave M cancel-with-restock / RMA restock). */
  async restock(id: string, quantity: number): Promise<MarketplaceListing> {
    const result = await this.pool.query(
      `UPDATE marketplace.listings
          SET quantity = quantity + $2
        WHERE id = $1
        RETURNING ${listingMapper.columns.join(', ')}`,
      [id, quantity]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Resource with id '${id}' not found`);
    }
    return listingMapper.fromRow(result.rows[0]);
  }
}

export function orderCriteriaSql(criteria: OrderCriteria): WhereClause {
  return composeWhere(
    eq('buyer_id', criteria.buyerId),
    eq('seller_id', criteria.sellerId),
    eq('status', criteria.status)
  );
}

export class PgOrderRepository
  extends PgRepositoryBase<Order, OrderCriteria>
  implements OrderRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.orders', mapper: orderMapper, criteria: orderCriteriaSql });
  }

  /**
   * Order placement in one transaction (plan §10.15) with atomic stock
   * decrement (funds-integrity wave): the listing quantity is decremented by
   * a conditional UPDATE (`quantity >= $n`), so concurrent orders cannot
   * oversell — the loser gets 0 rows and the order is rejected.
   */
  async placeOrder(order: Order): Promise<Order> {
    return this.withTransaction(async (client) => {
      const decremented = await client.query(
        `UPDATE marketplace.listings
            SET quantity = quantity - $2
          WHERE id = $1 AND is_active AND seller_id <> $3 AND quantity >= $2 AND $2 > 0
        RETURNING seller_id, quantity`,
        [order.listingId, order.quantity, order.buyerId]
      );
      if (!decremented.rows[0]) {
        // Re-read to surface the precise rejection reason.
        const listing = await client.query(
          `SELECT seller_id, quantity, is_active FROM marketplace.listings WHERE id = $1`,
          [order.listingId]
        );
        const row = listing.rows[0] as
          | { seller_id: string; quantity: string; is_active: boolean }
          | undefined;
        if (!row || !row.is_active) {
          throw new BadRequestException('Listing is not active');
        }
        if (row.seller_id === order.buyerId) {
          throw new BadRequestException('Sellers cannot order their own listing');
        }
        throw new BadRequestException(`Quantity must be between 1 and ${row.quantity}`);
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
