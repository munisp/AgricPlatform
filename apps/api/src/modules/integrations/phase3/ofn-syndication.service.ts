import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { newId } from '../../../common/async-repository.js';
import { INBOUND_EVENT_REPOSITORY } from '../../../database/persistence.tokens.js';
import type { InboundEventRepository } from '../../../database/repositories/phase3.repository.js';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import { MarketplaceService } from '../../marketplace/marketplace.service.js';
import { createOfnClient, ofnDriverEnabled, type OfnClient } from '../drivers/ofn.client.js';
import { payloadDedupeKey } from './phase3.utils.js';

/** OFN payment_state → platform settlement status. */
export type SettlementStatus = 'pending' | 'invoiced' | 'settled';

export function settlementStatusFor(paymentState: unknown): SettlementStatus {
  switch (paymentState) {
    case 'paid':
    case 'settled':
      return 'settled';
    case 'credit_owed':
    case 'invoiced':
      return 'invoiced';
    default:
      return 'pending';
  }
}

export interface OfnOrderEventResult {
  received: boolean;
  settlementStatus?: SettlementStatus;
}

/**
 * Open Food Network syndication (wave P5a). Outbound: pushes active NYFN
 * marketplace listings to the hub's OFN enterprise (listing id carried as
 * the OFN SKU for order correlation). Inbound: order events are ledgered
 * replay-safe and republished as marketplace domain events with a
 * normalised settlement status. Inert while OFN_DRIVER is stub.
 */
@Injectable()
export class OfnSyndicationService {
  constructor(
    private readonly marketplace: MarketplaceService,
    @Inject(INBOUND_EVENT_REPOSITORY) private readonly inbound: InboundEventRepository,
    private readonly events: DomainEventsService,
    @Optional() private readonly client: OfnClient | undefined = createOfnClient(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get enabled(): boolean {
    return ofnDriverEnabled(this.env) && this.client !== undefined;
  }

  /** Pushes all active listings to OFN; returns per-listing product ids. */
  async syndicateActiveListings(): Promise<{ pushed: number; results: Record<string, string> }> {
    if (!this.client) {
      throw new BadRequestException('OFN syndication is disabled (OFN_DRIVER is stub or unkeyed)');
    }
    const listings = (await this.marketplace.allListings()).filter((listing) => listing.isActive);
    const results: Record<string, string> = {};
    for (const listing of listings) {
      const pushed = await this.client.pushListing({
        name: listing.title,
        price: listing.priceNaira,
        sku: listing.id,
        description: listing.crop ? `Crop: ${listing.crop}` : undefined
      });
      results[listing.id] = pushed.productId;
    }
    await this.events.publish('marketplace.ofn_syndication.completed', {
      pushed: listings.length
    });
    return { pushed: listings.length, results };
  }

  /**
   * Inbound OFN order event: ledgered (replay-safe), normalised onto the
   * marketplace order domain and republished with the settlement status.
   */
  async handleOrderEvent(
    payload: Record<string, unknown>,
    eventId?: string
  ): Promise<OfnOrderEventResult> {
    const dedupeKey = eventId ?? String(payload['number'] ?? payload['id'] ?? payloadDedupeKey(payload));
    const event = await this.inbound.ingest({
      id: newId('evt'),
      system: 'ofn',
      eventType: String(payload['event'] ?? 'order.created'),
      dedupeKey,
      payload,
      receivedAt: new Date().toISOString()
    });
    if (!event) {
      return { received: false };
    }
    const settlementStatus = settlementStatusFor(payload['payment_state']);
    await this.events.publish('marketplace.ofn_order.received', {
      ofnOrderId: String(payload['number'] ?? payload['id'] ?? ''),
      /** Platform listing id carried as the OFN SKU at syndication time. */
      listingId: payload['sku'] !== undefined ? String(payload['sku']) : undefined,
      quantity: typeof payload['quantity'] === 'number' ? payload['quantity'] : undefined,
      totalNaira: typeof payload['total'] === 'number' ? payload['total'] : undefined,
      settlementStatus
    });
    await this.inbound.markProcessed(event.id, new Date().toISOString());
    return { received: true, settlementStatus };
  }
}
