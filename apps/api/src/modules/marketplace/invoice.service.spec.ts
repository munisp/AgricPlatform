import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryInvoiceRepository } from '../../database/repositories/invoice.repository.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InvoiceService } from './invoice.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };

// Seed order 'order-buyer-cassava': 2 × ₦185,000 cassava = ₦370,000.
function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const invoices = createInMemoryInvoiceRepository();
  const service = new InvoiceService(
    events,
    invoices,
    createInMemoryOrderRepository(),
    createInMemoryListingRepository()
  );
  return { service, events, invoices };
}

describe('InvoiceService', () => {
  it('issues an invoice with VAT 7.5% in integer kobo', async () => {
    const { service } = makeService();
    const invoice = await service.issueForOrder('order-buyer-cassava', seller.id);
    expect(invoice.status).toBe('issued');
    expect(invoice.invoiceNumber).toBe('INV-user-adamu-000001');
    expect(invoice.subtotalKobo).toBe(37_000_000);
    expect(invoice.vatKobo).toBe(2_775_000); // 7.5%
    expect(invoice.totalKobo).toBe(39_775_000);
    expect(invoice.lineItems).toEqual([
      {
        description: 'Fresh cassava tubers — 5 tonnes',
        quantity: 2,
        unitPriceKobo: 18_500_000,
        totalKobo: 37_000_000
      }
    ]);
    expect(Number.isInteger(invoice.vatKobo)).toBe(true);
  });

  it('is idempotent per order and sequences per seller', async () => {
    const { service, invoices } = makeService();
    const first = await service.issueForOrder('order-buyer-cassava', seller.id);
    const replay = await service.issueForOrder('order-buyer-cassava', seller.id);
    expect(replay.id).toBe(first.id);
    // A second order for the same seller continues the sequence.
    const orders = createInMemoryOrderRepository();
    await orders.create({
      id: 'order-second',
      listingId: 'listing-cassava-kaduna',
      buyerId: 'user-buyer',
      sellerId: 'user-adamu',
      quantity: 1,
      totalNaira: 185_000,
      status: 'confirmed',
      escrowRequired: true,
      createdAt: new Date().toISOString()
    });
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const service2 = new InvoiceService(events, invoices, orders, createInMemoryListingRepository());
    const second = await service2.issueForOrder('order-second', seller.id);
    expect(second.invoiceNumber).toBe('INV-user-adamu-000002');
  });

  it('walks issued → paid with actor scoping and idempotent replay', async () => {
    const { service } = makeService();
    const invoice = await service.issueForOrder('order-buyer-cassava', seller.id);
    expect((await service.transition(invoice.id, 'issued', seller)).status).toBe('issued'); // replay
    expect((await service.transition(invoice.id, 'paid', buyer)).status).toBe('paid');
    expect((await service.getById(invoice.id)).paidAt).toBeDefined();
    // Terminal states reject further movement.
    await expect(service.transition(invoice.id, 'cancelled', admin)).rejects.toThrowError(
      /Invalid invoice transition/
    );
  });

  it('enforces the entitled party per transition', async () => {
    const { service } = makeService();
    const invoice = await service.issueForOrder('order-buyer-cassava', seller.id);
    await expect(
      service.transition(invoice.id, 'cancelled', { id: 'user-aisha', roles: ['student'] })
    ).rejects.toThrowError(ForbiddenException);
    expect((await service.transition(invoice.id, 'cancelled', seller)).status).toBe('cancelled');
  });

  it('system hooks mark paid and cancel from the order lifecycle', async () => {
    const { service } = makeService();
    const invoice = await service.issueForOrder('order-buyer-cassava', seller.id);
    expect((await service.markPaidForOrder('order-buyer-cassava', admin.id))?.status).toBe('paid');
    // Already-paid invoices are left alone by the cancellation hook.
    expect((await service.cancelForOrder('order-buyer-cassava', admin.id))?.status).toBe('paid');
    await expect(service.issueForOrder('order-buyer-cassava', seller.id)).resolves.toMatchObject({
      id: invoice.id
    });
  });

  it('serialises a PDF-ready structured document', async () => {
    const { service } = makeService();
    const invoice = await service.issueForOrder('order-buyer-cassava', seller.id);
    const doc = await service.serialise(invoice.id);
    expect(doc.document).toBe('invoice');
    expect(doc.invoiceNumber).toBe('INV-user-adamu-000001');
    expect(doc.totals).toMatchObject({
      subtotalKobo: 37_000_000,
      vatRateBps: 750,
      vatKobo: 2_775_000,
      totalKobo: 39_775_000
    });
    expect(doc.totals.totalFormatted).toContain('397,750');
    expect(doc.lines[0].unitPriceFormatted).toContain('185,000');
  });

  it('rejects invoicing a cancelled order', async () => {
    const orders = createInMemoryOrderRepository();
    await orders.update('order-buyer-cassava', { status: 'cancelled' });
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const service = new InvoiceService(
      events,
      createInMemoryInvoiceRepository(),
      orders,
      createInMemoryListingRepository()
    );
    await expect(service.issueForOrder('order-buyer-cassava', seller.id)).rejects.toThrowError(
      BadRequestException
    );
  });
});
