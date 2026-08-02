import type { Invoice, InvoiceStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface InvoiceCriteria {
  orderId?: string;
  sellerId?: string;
  buyerId?: string;
  status?: InvoiceStatus;
}

export interface InvoiceRepository extends AsyncRepository<Invoice, InvoiceCriteria> {
  /**
   * Allocates the next per-seller invoice sequence number. The pg
   * implementation increments marketplace.invoice_counters with
   * INSERT … ON CONFLICT … RETURNING so concurrent issuances never collide.
   */
  nextInvoiceSequence(sellerId: string): Promise<number>;
}

export function invoiceMatcher(criteria: InvoiceCriteria): (invoice: Invoice) => boolean {
  return (invoice) =>
    (!criteria.orderId || invoice.orderId === criteria.orderId) &&
    (!criteria.sellerId || invoice.sellerId === criteria.sellerId) &&
    (!criteria.buyerId || invoice.buyerId === criteria.buyerId) &&
    (!criteria.status || invoice.status === criteria.status);
}

export class InMemoryInvoiceRepository
  extends InMemoryRepository<Invoice, InvoiceCriteria>
  implements InvoiceRepository
{
  private readonly counters = new Map<string, number>();

  constructor(seed: readonly Invoice[] = []) {
    super(seed, invoiceMatcher);
  }

  async nextInvoiceSequence(sellerId: string): Promise<number> {
    const next = this.counters.get(sellerId) ?? 1;
    this.counters.set(sellerId, next + 1);
    return next;
  }
}

export function createInMemoryInvoiceRepository(): InMemoryInvoiceRepository {
  return new InMemoryInvoiceRepository();
}
