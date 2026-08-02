import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Order, OrderStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedOrders } from '../seed-data.js';
import type { ListingRepository } from './listing.repository.js';

export interface OrderCriteria {
  buyerId?: string;
  sellerId?: string;
  status?: OrderStatus;
}

export interface OrderRepository extends AsyncRepository<Order, OrderCriteria> {
  /**
   * Order placement as one atomic unit (plan §10 task 15): the pg
   * implementation locks the listing row FOR UPDATE and re-validates
   * availability before inserting.
   */
  placeOrder(order: Order): Promise<Order>;
}

export function orderMatcher(criteria: OrderCriteria): (order: Order) => boolean {
  return (order) =>
    (!criteria.buyerId || order.buyerId === criteria.buyerId) &&
    (!criteria.sellerId || order.sellerId === criteria.sellerId) &&
    (!criteria.status || order.status === criteria.status);
}

export class InMemoryOrderRepository
  extends InMemoryRepository<Order, OrderCriteria>
  implements OrderRepository
{
  /**
   * When a listing repository is attached, placeOrder decrements the listing
   * quantity with the same compare-and-set guard the pg implementation
   * compiles to SQL (oversell protection, funds-integrity wave).
   */
  constructor(
    seed: readonly Order[] = [],
    private readonly listings?: ListingRepository
  ) {
    super(seed, orderMatcher);
  }

  async placeOrder(order: Order): Promise<Order> {
    if (this.listings) {
      const listing = await this.listings.getById(order.listingId);
      if (!listing.isActive) {
        throw new BadRequestException('Listing is not active');
      }
      if (order.quantity <= 0 || order.quantity > listing.quantity) {
        throw new BadRequestException(`Quantity must be between 1 and ${listing.quantity}`);
      }
      if (listing.sellerId === order.buyerId) {
        throw new BadRequestException('Sellers cannot order their own listing');
      }
      try {
        await this.listings.updateExpected(
          listing.id,
          { quantity: listing.quantity - order.quantity },
          { quantity: listing.quantity, isActive: true }
        );
      } catch (error) {
        if (error instanceof ConflictException) {
          // A concurrent order took the stock between read and write.
          const fresh = await this.listings.getById(order.listingId);
          throw new BadRequestException(`Quantity must be between 1 and ${fresh.quantity}`);
        }
        throw error;
      }
    }
    return this.create(order);
  }
}

export function createInMemoryOrderRepository(
  listings?: ListingRepository
): InMemoryOrderRepository {
  return new InMemoryOrderRepository(seedOrders, listings);
}
