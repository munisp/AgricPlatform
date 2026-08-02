import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { ReturnRequest, ReturnStatus, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  LISTING_REPOSITORY,
  LISTING_VARIANT_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  RETURN_REQUEST_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  ListingVariantRepository,
  OrderExtensionRepository,
  ReturnRequestRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { EscrowService } from '../marketplace/escrow.service.js';

/** Which party may drive each return transition (admins may drive any). */
type ReturnActor = 'buyer' | 'seller';

/**
 * RMA state machine: requested → approved → received → refunded|rejected.
 * Terminal states accept no outbound transitions; re-sending the current
 * status is an idempotent no-op (same replay semantics as the order and
 * escrow machines). The buyer may withdraw a still-open request
 * (requested|approved → rejected).
 */
export const RETURN_TRANSITIONS: Readonly<
  Record<ReturnStatus, Readonly<Partial<Record<ReturnStatus, readonly ReturnActor[]>>>>
> = {
  requested: {
    approved: ['seller'],
    rejected: ['buyer', 'seller']
  },
  approved: {
    received: ['seller'],
    rejected: ['buyer', 'seller']
  },
  received: {
    refunded: ['seller'],
    rejected: ['seller']
  },
  refunded: {},
  rejected: {}
};

const OPEN_STATUSES: readonly ReturnStatus[] = ['requested', 'approved', 'received'];

/**
 * Feature 6 (Wave M): RMA / returns on fulfilled orders. The 'refunded'
 * transition invokes the escrow service's guarded refund path
 * (persist-intent-before-provider-call) — never a raw status write. The
 * 'received' transition optionally restocks the purchased variant/listing.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(RETURN_REQUEST_REPOSITORY) private readonly returns: ReturnRequestRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ORDER_EXTENSION_REPOSITORY) private readonly extensions: OrderExtensionRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository,
    private readonly escrow: EscrowService
  ) {}

  async requestReturn(
    orderId: string,
    buyerId: string,
    reason: string,
    restock: boolean,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<ReturnRequest> {
    const order = await this.orders.getById(orderId);
    if (order.status !== 'delivered' && order.status !== 'completed') {
      throw new BadRequestException('Returns can only be requested on fulfilled (delivered/completed) orders');
    }
    if (order.buyerId !== buyerId) {
      throw new ForbiddenException('Only the order buyer may request a return');
    }
    if (actor.id !== buyerId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the order buyer or an administrator may request a return');
    }
    if (!reason.trim()) {
      throw new BadRequestException('A return reason is required');
    }
    for (const existing of await this.returns.find({ orderId })) {
      if (OPEN_STATUSES.includes(existing.status)) {
        throw new ConflictException(`Order ${orderId} already has an open return request (${existing.id})`);
      }
    }
    const now = new Date().toISOString();
    const request: ReturnRequest = {
      id: newId('return'),
      orderId,
      buyerId,
      reason: reason.trim(),
      status: 'requested',
      restock,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.returns.create(request);
    await this.events.publish('marketplace.return.requested', { returnId: created.id, orderId }, actor.id);
    return created;
  }

  /**
   * Party-scoped listing (G2): admins see everything; anyone else is
   * restricted to their own returns. Without an explicit buyerId a
   * non-admin caller defaults to buyerId=self (mirrors listDrafts); an
   * orderId filter additionally requires the caller to be a party to that
   * order (buyer or seller).
   */
  async listReturns(
    filter: { orderId?: string; buyerId?: string; status?: ReturnStatus },
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<ReturnRequest[]> {
    if (actor.roles.includes('admin')) {
      return this.returns.find(filter);
    }
    const scoped = { ...filter };
    if (scoped.buyerId && scoped.buyerId !== actor.id) {
      throw new ForbiddenException('You may only list your own return requests');
    }
    if (scoped.orderId) {
      const order = await this.orders.getById(scoped.orderId);
      if (order.buyerId !== actor.id && order.sellerId !== actor.id) {
        throw new ForbiddenException(
          'You may only access returns for orders you are a party to'
        );
      }
    }
    if (!scoped.buyerId && !scoped.orderId) {
      scoped.buyerId = actor.id;
    }
    return this.returns.find(scoped);
  }

  async getReturn(id: string): Promise<ReturnRequest> {
    return this.returns.getById(id);
  }

  async transition(
    id: string,
    status: ReturnStatus,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<ReturnRequest> {
    const request = await this.returns.getById(id);
    if (request.status === status) {
      return request; // idempotent replay of a retry
    }
    const allowed = RETURN_TRANSITIONS[request.status]?.[status];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid return transition '${request.status}' -> '${status}' for return ${id}`
      );
    }
    const order = await this.orders.getById(request.orderId);
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin) {
      const party: ReturnActor | null =
        actor.id === request.buyerId ? 'buyer' : actor.id === order.sellerId ? 'seller' : null;
      if (!party || !allowed.includes(party)) {
        throw new ForbiddenException(
          `Only the order ${allowed.length > 0 ? allowed.join(' or ') : 'administrator'} may move a return from '${request.status}' to '${status}'`
        );
      }
    }
    const terminal = status === 'refunded' || status === 'rejected';
    const event = this.events.build(
      'marketplace.return.status_changed',
      { returnId: id, orderId: request.orderId, from: request.status, to: status },
      actor.id
    );
    const updated = await this.returns.updateExpected(
      id,
      {
        status,
        updatedAt: new Date().toISOString(),
        resolvedAt: terminal ? new Date().toISOString() : undefined
      },
      { status: request.status },
      event
    );
    if (this.returns.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    if (status === 'received' && request.restock) {
      const extension = await this.extensions.findById(request.orderId);
      if (extension?.variantId) {
        await this.variants.restock(extension.variantId, order.quantity);
      } else {
        await this.listings.restock(order.listingId, order.quantity);
      }
    } else if (status === 'refunded') {
      // Guarded escrow refund (persist-intent-first); no-op when the order
      // has no held escrow (e.g. below the escrow threshold).
      await this.escrow.refundForOrder(request.orderId, actor.id);
    }
    return updated;
  }
}
