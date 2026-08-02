import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { ListingVariant, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { LISTING_REPOSITORY, LISTING_VARIANT_REPOSITORY } from '../../database/persistence.tokens.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { ListingVariantRepository } from '../../database/repositories/commerce-depth.repository.js';

export interface CreateVariantInput {
  sku: string;
  name: string;
  attributes?: Record<string, string>;
  priceKobo: number;
  quantity: number;
}

export interface UpdateVariantInput {
  name?: string;
  attributes?: Record<string, string>;
  priceKobo?: number;
  quantity?: number;
  isActive?: boolean;
}

/**
 * Feature 1 (Wave M): listing variants & SKUs. Every variant carries its own
 * price (integer kobo) and stock; order placement decrements the variant row
 * atomically (ListingVariantRepository.decrementStock).
 */
@Injectable()
export class VariantsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository
  ) {}

  async listForListing(listingId: string, activeOnly = false): Promise<ListingVariant[]> {
    await this.listings.getById(listingId); // 404 for unknown listings
    return this.variants.find({ listingId, active: activeOnly ? true : undefined });
  }

  async getVariant(id: string): Promise<ListingVariant> {
    return this.variants.getById(id);
  }

  async createVariant(
    listingId: string,
    input: CreateVariantInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<ListingVariant> {
    const listing = await this.listings.getById(listingId);
    this.assertSellerOrAdmin(listing.sellerId, actor);
    if (!input.sku.trim()) {
      throw new BadRequestException('A variant SKU is required');
    }
    if (input.priceKobo < 0 || !Number.isSafeInteger(input.priceKobo)) {
      throw new BadRequestException('Variant price must be a non-negative kobo integer');
    }
    if (input.quantity < 0 || !Number.isSafeInteger(input.quantity)) {
      throw new BadRequestException('Variant quantity must be a non-negative integer');
    }
    const now = new Date().toISOString();
    const variant: ListingVariant = {
      id: newId('variant'),
      listingId,
      sku: input.sku.trim(),
      name: input.name,
      attributes: input.attributes ?? {},
      priceKobo: input.priceKobo,
      quantity: input.quantity,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.variants.create(variant);
    await this.events.publish(
      'marketplace.variant.created',
      { variantId: created.id, listingId, sku: created.sku },
      actor.id
    );
    return created;
  }

  async updateVariant(
    id: string,
    patch: UpdateVariantInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<ListingVariant> {
    const variant = await this.variants.getById(id);
    const listing = await this.listings.getById(variant.listingId);
    this.assertSellerOrAdmin(listing.sellerId, actor);
    if (patch.priceKobo !== undefined && (patch.priceKobo < 0 || !Number.isSafeInteger(patch.priceKobo))) {
      throw new BadRequestException('Variant price must be a non-negative kobo integer');
    }
    if (patch.quantity !== undefined && (patch.quantity < 0 || !Number.isSafeInteger(patch.quantity))) {
      throw new BadRequestException('Variant quantity must be a non-negative integer');
    }
    const updated = await this.variants.update(id, { ...patch, updatedAt: new Date().toISOString() });
    await this.events.publish(
      'marketplace.variant.updated',
      { variantId: id, listingId: variant.listingId },
      actor.id
    );
    return updated;
  }

  private assertSellerOrAdmin(sellerId: string, actor: Pick<User, 'id' | 'roles'>): void {
    if (actor.id !== sellerId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the listing seller or an administrator may manage variants');
    }
  }
}
