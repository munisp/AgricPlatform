import type { Order, OrderStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedOrders } from '../seed-data.js';

export interface OrderCriteria {
  buyerId?: string;
  sellerId?: string;
  status?: OrderStatus;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OrderRepository extends AsyncRepository<Order, OrderCriteria> {}

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
  constructor(seed: readonly Order[] = []) {
    super(seed, orderMatcher);
  }
}

export function createInMemoryOrderRepository(): InMemoryOrderRepository {
  return new InMemoryOrderRepository(seedOrders);
}
