import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import {
  computeVatKobo,
  formatNaira,
  VAT_RATE_BPS,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceStatus,
  type User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  INVOICE_REPOSITORY,
  LISTING_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { InvoiceCriteria, InvoiceRepository } from '../../database/repositories/invoice.repository.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';

type InvoiceActor = 'buyer' | 'seller';

/**
 * Invoice state machine: DRAFT → ISSUED → PAID, CANCELLED from DRAFT/ISSUED.
 * Terminal states accept no outbound transitions; re-sending the current
 * status is an idempotent no-op.
 */
export const INVOICE_TRANSITIONS: Readonly<
  Record<InvoiceStatus, Readonly<Partial<Record<InvoiceStatus, readonly InvoiceActor[]>>>>
> = {
  draft: {
    issued: ['seller'],
    cancelled: ['seller']
  },
  issued: {
    paid: ['buyer', 'seller'],
    cancelled: ['seller']
  },
  paid: {},
  cancelled: {}
};

/** PDF-ready serialisation payload (structured JSON until the PDF renderer lands). */
export interface InvoiceDocument {
  document: 'invoice';
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: 'NGN';
  issuedAt?: string;
  paidAt?: string;
  seller: { id: string };
  buyer: { id: string };
  lines: Array<InvoiceLineItem & { unitPriceFormatted: string; totalFormatted: string }>;
  totals: {
    subtotalKobo: number;
    vatRateBps: number;
    vatKobo: number;
    totalKobo: number;
    subtotalFormatted: string;
    vatFormatted: string;
    totalFormatted: string;
  };
}

@Injectable()
export class InvoiceService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  async list(filter: InvoiceCriteria): Promise<Invoice[]> {
    return this.invoices.find(filter);
  }

  async getById(id: string): Promise<Invoice> {
    return this.invoices.getById(id);
  }

  async invoiceForOrder(orderId: string): Promise<Invoice | undefined> {
    return this.invoices.findOne({ orderId });
  }

  /**
   * Issue-on-order-confirm flow: builds the invoice from the order and its
   * listing with VAT 7.5% in integer kobo. Idempotent per order — retries
   * return the existing invoice instead of duplicating the number sequence.
   */
  async issueForOrder(orderId: string, actorId: string): Promise<Invoice> {
    const existing = await this.invoiceForOrder(orderId);
    if (existing && existing.status !== 'cancelled') {
      return existing;
    }
    const order = await this.orders.getById(orderId);
    if (order.status === 'cancelled') {
      throw new BadRequestException(`Cannot invoice a cancelled order (${orderId})`);
    }
    const listing = await this.listings.getById(order.listingId);
    const unitPriceKobo = listing.priceNaira * 100;
    if (!Number.isSafeInteger(unitPriceKobo)) {
      throw new BadRequestException(`Listing ${listing.id} price is not representable in kobo`);
    }
    const lineItems: InvoiceLineItem[] = [
      {
        description: listing.title,
        quantity: order.quantity,
        unitPriceKobo,
        totalKobo: unitPriceKobo * order.quantity
      }
    ];
    const subtotalKobo = lineItems.reduce((sum, line) => sum + line.totalKobo, 0);
    const vatKobo = computeVatKobo(subtotalKobo);
    const sequence = await this.invoices.nextInvoiceSequence(order.sellerId);
    const invoice: Invoice = {
      id: newId('invoice'),
      invoiceNumber: `INV-${order.sellerId}-${String(sequence).padStart(6, '0')}`,
      orderId,
      sellerId: order.sellerId,
      buyerId: order.buyerId,
      status: 'issued',
      currency: 'NGN',
      subtotalKobo,
      vatKobo,
      totalKobo: subtotalKobo + vatKobo,
      lineItems,
      issuedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    const created = await this.invoices.create(invoice);
    await this.audit?.record({
      actorId,
      action: 'marketplace.invoice.issued',
      entityType: 'invoice',
      entityId: created.id,
      metadata: { orderId, invoiceNumber: created.invoiceNumber, totalKobo: created.totalKobo }
    });
    await this.events.publish(
      'marketplace.invoice.issued',
      { invoiceId: created.id, orderId, invoiceNumber: created.invoiceNumber, totalKobo: created.totalKobo },
      actorId
    );
    return created;
  }

  async transition(
    id: string,
    status: InvoiceStatus,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Invoice> {
    const invoice = await this.invoices.getById(id);
    if (invoice.status === status) {
      return invoice; // idempotent replay
    }
    const allowed = INVOICE_TRANSITIONS[invoice.status]?.[status];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid invoice transition '${invoice.status}' -> '${status}' for invoice ${id}`
      );
    }
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin) {
      const party: InvoiceActor | null =
        actor.id === invoice.buyerId ? 'buyer' : actor.id === invoice.sellerId ? 'seller' : null;
      if (!party || !allowed.includes(party)) {
        throw new ForbiddenException(
          `Only the invoice ${allowed.join(' or ')} may move an invoice from '${invoice.status}' to '${status}'`
        );
      }
    }
    return this.applyTransition(invoice, status, actor.id);
  }

  /** System-path payment marking when the underlying order completes. */
  async markPaidForOrder(orderId: string, actorId: string): Promise<Invoice | undefined> {
    const invoice = await this.invoiceForOrder(orderId);
    if (!invoice || invoice.status !== 'issued') {
      return invoice;
    }
    return this.applyTransition(invoice, 'paid', actorId);
  }

  /** System-path cancellation when the underlying order is cancelled. */
  async cancelForOrder(orderId: string, actorId: string): Promise<Invoice | undefined> {
    const invoice = await this.invoiceForOrder(orderId);
    if (!invoice || (invoice.status !== 'issued' && invoice.status !== 'draft')) {
      return invoice;
    }
    return this.applyTransition(invoice, 'cancelled', actorId);
  }

  private async applyTransition(
    invoice: Invoice,
    status: InvoiceStatus,
    actorId: string
  ): Promise<Invoice> {
    const updated = await this.invoices.update(invoice.id, {
      status,
      paidAt: status === 'paid' ? new Date().toISOString() : undefined
    });
    if (status === 'paid' || status === 'cancelled') {
      await this.audit?.record({
        actorId,
        action: `marketplace.invoice.${status}`,
        entityType: 'invoice',
        entityId: invoice.id,
        metadata: { from: invoice.status, to: status, totalKobo: invoice.totalKobo }
      });
    }
    await this.events.publish(
      'marketplace.invoice.status_changed',
      { invoiceId: invoice.id, orderId: invoice.orderId, from: invoice.status, to: status },
      actorId
    );
    return updated;
  }

  /** PDF-ready serialisation: structured JSON the renderer consumes as-is. */
  async serialise(id: string): Promise<InvoiceDocument> {
    const invoice = await this.invoices.getById(id);
    return {
      document: 'invoice',
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt,
      seller: { id: invoice.sellerId },
      buyer: { id: invoice.buyerId },
      lines: invoice.lineItems.map((line) => ({
        ...line,
        unitPriceFormatted: formatNaira(line.unitPriceKobo / 100),
        totalFormatted: formatNaira(line.totalKobo / 100)
      })),
      totals: {
        subtotalKobo: invoice.subtotalKobo,
        vatRateBps: VAT_RATE_BPS,
        vatKobo: invoice.vatKobo,
        totalKobo: invoice.totalKobo,
        subtotalFormatted: formatNaira(invoice.subtotalKobo / 100),
        vatFormatted: formatNaira(invoice.vatKobo / 100),
        totalFormatted: formatNaira(invoice.totalKobo / 100)
      }
    };
  }
}
