import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PriceList, PriceListEntry, ResolvedPrice, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  LISTING_VARIANT_REPOSITORY,
  PRICE_LIST_ENTRY_REPOSITORY,
  PRICE_LIST_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ListingVariantRepository,
  PriceListEntryRepository,
  PriceListRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { BuyerGroupsService, assertBuyerGroupManager } from './buyer-groups.service.js';

export interface CreatePriceListInput {
  name: string;
  description?: string;
  buyerGroupId?: string;
  startsAt?: string;
  endsAt?: string;
  priority?: number;
}

export interface UpdatePriceListInput {
  name?: string;
  description?: string;
  buyerGroupId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  priority?: number;
  isActive?: boolean;
}

/**
 * Feature 3 (Wave M): named price lists with validity windows that override
 * variant prices for specific buyer groups. Resolution picks the best
 * (lowest) applicable price; ties break on higher list priority.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(PRICE_LIST_REPOSITORY) private readonly priceLists: PriceListRepository,
    @Inject(PRICE_LIST_ENTRY_REPOSITORY) private readonly entries: PriceListEntryRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository,
    private readonly buyerGroups: BuyerGroupsService
  ) {}

  async listPriceLists(): Promise<PriceList[]> {
    return this.priceLists.all();
  }

  async getPriceList(id: string): Promise<PriceList> {
    return this.priceLists.getById(id);
  }

  async createPriceList(input: CreatePriceListInput, actor: Pick<User, 'id' | 'roles'>): Promise<PriceList> {
    assertBuyerGroupManager(actor);
    if (!input.name.trim()) {
      throw new BadRequestException('A price list name is required');
    }
    if (input.buyerGroupId) {
      await this.buyerGroups.getGroup(input.buyerGroupId);
    }
    this.assertValidWindow(input.startsAt, input.endsAt);
    const now = new Date().toISOString();
    const priceList: PriceList = {
      id: newId('pricelist'),
      name: input.name.trim(),
      description: input.description,
      buyerGroupId: input.buyerGroupId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      priority: input.priority ?? 0,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.priceLists.create(priceList);
    await this.events.publish('marketplace.price_list.created', { priceListId: created.id }, actor.id);
    return created;
  }

  async updatePriceList(
    id: string,
    patch: UpdatePriceListInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<PriceList> {
    assertBuyerGroupManager(actor);
    const current = await this.priceLists.getById(id);
    const startsAt = patch.startsAt === null ? undefined : patch.startsAt ?? current.startsAt;
    const endsAt = patch.endsAt === null ? undefined : patch.endsAt ?? current.endsAt;
    this.assertValidWindow(startsAt, endsAt);
    if (patch.buyerGroupId) {
      await this.buyerGroups.getGroup(patch.buyerGroupId);
    }
    const updated = await this.priceLists.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.buyerGroupId !== undefined
        ? { buyerGroupId: patch.buyerGroupId === null ? undefined : patch.buyerGroupId }
        : {}),
      ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt === null ? undefined : patch.startsAt } : {}),
      ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt === null ? undefined : patch.endsAt } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      updatedAt: new Date().toISOString()
    });
    await this.events.publish('marketplace.price_list.updated', { priceListId: id }, actor.id);
    return updated;
  }

  async listEntries(priceListId: string): Promise<PriceListEntry[]> {
    await this.priceLists.getById(priceListId);
    return this.entries.find({ priceListId });
  }

  async setEntry(
    priceListId: string,
    variantId: string,
    priceKobo: number,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<PriceListEntry> {
    assertBuyerGroupManager(actor);
    await this.priceLists.getById(priceListId);
    await this.variants.getById(variantId);
    if (priceKobo < 0 || !Number.isSafeInteger(priceKobo)) {
      throw new BadRequestException('Price list entry price must be a non-negative kobo integer');
    }
    const entry = await this.entries.upsert({
      id: newId('plentry'),
      priceListId,
      variantId,
      priceKobo
    });
    await this.events.publish(
      'marketplace.price_list.entry_set',
      { priceListId, variantId, priceKobo },
      actor.id
    );
    return entry;
  }

  /**
   * Best applicable price for a buyer on a variant: the lowest entry price
   * among active, in-window price lists the buyer qualifies for (group-less
   * lists apply to everyone); ties break on higher priority. Falls back to
   * the variant list price when no list applies.
   */
  async resolvePrice(variantId: string, buyerId?: string, at: string = new Date().toISOString()): Promise<ResolvedPrice> {
    const variant = await this.variants.getById(variantId);
    const candidates = await this.entries.find({ variantId });
    const buyerGroupIds = buyerId ? await this.buyerGroups.groupIdsForUser(buyerId) : [];
    let best: { priceKobo: number; priceListId: string; priority: number } | undefined;
    for (const candidate of candidates) {
      const list = await this.priceLists.findById(candidate.priceListId);
      if (!list || !list.isActive) {
        continue;
      }
      if (list.startsAt && list.startsAt > at) {
        continue;
      }
      if (list.endsAt && list.endsAt < at) {
        continue;
      }
      if (list.buyerGroupId && !buyerGroupIds.includes(list.buyerGroupId)) {
        continue;
      }
      if (
        !best ||
        candidate.priceKobo < best.priceKobo ||
        (candidate.priceKobo === best.priceKobo && list.priority > best.priority)
      ) {
        best = { priceKobo: candidate.priceKobo, priceListId: list.id, priority: list.priority };
      }
    }
    return {
      variantId,
      priceKobo: best?.priceKobo ?? variant.priceKobo,
      priceListId: best?.priceListId,
      listPriceKobo: variant.priceKobo
    };
  }

  private assertValidWindow(startsAt?: string, endsAt?: string): void {
    if (startsAt && endsAt && startsAt > endsAt) {
      throw new BadRequestException('Price list starts_at must not be after ends_at');
    }
  }
}
