import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryListingVariantRepository } from '../../database/repositories/commerce-depth.repository.js';
import { VariantsService } from './variants.service.js';

const seller: Pick<User, 'id' | 'roles'> = { id: 'user-farmer-2', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

// Seed listing 'listing-maize-kano' belongs to seller user-farmer-2.
function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const variants = createInMemoryListingVariantRepository();
  const service = new VariantsService(events, createInMemoryListingRepository(), variants);
  return { service, variants, events };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    sku: 'MAIZE-KANO-50KG-A',
    name: 'Grade A — 50kg bag',
    attributes: { grade: 'A', bagSizeKg: '50' },
    priceKobo: 2_100_000,
    quantity: 10,
    ...overrides
  };
}

describe('VariantsService', () => {
  it('creates a variant with SKU, kobo price and own stock', async () => {
    const { service } = makeService();
    const variant = await service.createVariant('listing-maize-kano', input(), seller);
    expect(variant.id).toMatch(/^variant-/);
    expect(variant.sku).toBe('MAIZE-KANO-50KG-A');
    expect(variant.priceKobo).toBe(2_100_000);
    expect(variant.quantity).toBe(10);
    expect(variant.isActive).toBe(true);
  });

  it('lists variants per listing', async () => {
    const { service } = makeService();
    await service.createVariant('listing-maize-kano', input(), seller);
    await service.createVariant('listing-maize-kano', input({ sku: 'MAIZE-KANO-25KG-A' }), seller);
    expect(await service.listForListing('listing-maize-kano')).toHaveLength(2);
    expect(await service.listForListing('listing-cassava-kaduna')).toHaveLength(0);
  });

  it('rejects duplicate SKUs (UNIQUE semantics)', async () => {
    const { service } = makeService();
    await service.createVariant('listing-maize-kano', input(), seller);
    await expect(service.createVariant('listing-cassava-kaduna', input(), admin)).rejects.toThrowError(
      ConflictException
    );
  });

  it('rejects negative prices and quantities', async () => {
    const { service } = makeService();
    await expect(service.createVariant('listing-maize-kano', input({ priceKobo: -1 }), seller)).rejects.toThrowError(
      BadRequestException
    );
    await expect(service.createVariant('listing-maize-kano', input({ quantity: -2 }), seller)).rejects.toThrowError(
      BadRequestException
    );
    await expect(service.createVariant('listing-maize-kano', input({ sku: ' ' }), seller)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('scopes management to the listing seller or an admin', async () => {
    const { service } = makeService();
    await expect(service.createVariant('listing-maize-kano', input(), outsider)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(service.createVariant('listing-maize-kano', input(), admin)).resolves.toBeDefined();
  });

  it('updates price/stock/active state with validation', async () => {
    const { service } = makeService();
    const variant = await service.createVariant('listing-maize-kano', input(), seller);
    const updated = await service.updateVariant(variant.id, { priceKobo: 1_950_000, quantity: 7 }, seller);
    expect(updated.priceKobo).toBe(1_950_000);
    expect(updated.quantity).toBe(7);
    await expect(service.updateVariant(variant.id, { priceKobo: -5 }, seller)).rejects.toThrowError(
      BadRequestException
    );
    await expect(service.updateVariant(variant.id, { name: 'x' }, outsider)).rejects.toThrowError(ForbiddenException);
    expect((await service.updateVariant(variant.id, { isActive: false }, admin)).isActive).toBe(false);
  });

  it('404s on unknown listings and variants', async () => {
    const { service } = makeService();
    await expect(service.listForListing('listing-missing')).rejects.toThrowError(NotFoundException);
    await expect(service.updateVariant('variant-missing', { name: 'x' }, admin)).rejects.toThrowError(
      NotFoundException
    );
  });

  it('publishes created/updated domain events', async () => {
    const { service, events } = makeService();
    const variant = await service.createVariant('listing-maize-kano', input(), seller);
    await service.updateVariant(variant.id, { quantity: 3 }, seller);
    const names = (await events.listOutbox()).map((event) => event.name);
    expect(names).toEqual(['marketplace.variant.created', 'marketplace.variant.updated']);
  });

  it('decrements stock atomically and rejects oversell', async () => {
    const { service, variants } = makeService();
    const variant = await service.createVariant('listing-maize-kano', input({ quantity: 2 }), seller);
    await variants.decrementStock(variant.id, 2);
    await expect(variants.decrementStock(variant.id, 1)).rejects.toThrowError(/Quantity must be between 1 and 0/);
    await expect(variants.decrementStock(variant.id, 0)).rejects.toThrowError(BadRequestException);
  });

  it('restocks atomically', async () => {
    const { service, variants } = makeService();
    const variant = await service.createVariant('listing-maize-kano', input({ quantity: 2 }), seller);
    await variants.decrementStock(variant.id, 2);
    expect((await variants.restock(variant.id, 2)).quantity).toBe(2);
  });

  it('rejects decrement on inactive variants', async () => {
    const { service, variants } = makeService();
    const variant = await service.createVariant('listing-maize-kano', input(), seller);
    await service.updateVariant(variant.id, { isActive: false }, seller);
    await expect(variants.decrementStock(variant.id, 1)).rejects.toThrowError(/not active/);
  });
});
