import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  BuyerGroup,
  BuyerGroupMembership,
  DraftOrder,
  ListingVariant,
  Order,
  OrderExtension,
  PriceList,
  PriceListEntry,
  ProductReview,
  Promotion,
  PromotionRedemption,
  ReturnRequest,
  SalesChannel,
  SellerRating
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Wave M commerce-depth repository ports + in-memory implementations. The
 * in-memory variants mirror the pg semantics (funds-integrity wave):
 * conditional check-and-set writes with NO awaits inside the guard, and
 * UNIQUE-constraint violations surfaced as ConflictException.
 */

/* --------------------------- listing variants --------------------------- */

export interface ListingVariantCriteria {
  listingId?: string;
  sku?: string;
  active?: boolean;
}

export interface ListingVariantRepository
  extends AsyncRepository<ListingVariant, ListingVariantCriteria> {
  /**
   * Atomic stock decrement (oversell protection): succeeds only when the
   * variant is active and still has `quantity` units; throws
   * BadRequestException otherwise. Compiled to a conditional UPDATE on pg.
   */
  decrementStock(id: string, quantity: number): Promise<ListingVariant>;
  /** Atomic stock increment (order cancellation / RMA restock). */
  restock(id: string, quantity: number): Promise<ListingVariant>;
}

/**
 * Atomic variant checkout capability (G8). The pg implementation performs
 * the conditional stock decrement + order insert + order-extension insert in
 * ONE database transaction (all-or-nothing — no compensation window). The
 * in-memory implementation does not need it: its decrementStock is a
 * synchronous check-and-set, so the decrement→insert sequence cannot
 * interleave. Services detect this capability structurally.
 */
export interface AtomicVariantCheckoutRepository {
  placeVariantOrder(order: Order, extension: OrderExtension): Promise<Order>;
}

export function listingVariantMatcher(
  criteria: ListingVariantCriteria
): (variant: ListingVariant) => boolean {
  return (variant) =>
    (!criteria.listingId || variant.listingId === criteria.listingId) &&
    (!criteria.sku || variant.sku === criteria.sku) &&
    (criteria.active === undefined || variant.isActive === criteria.active);
}

export class InMemoryListingVariantRepository
  extends InMemoryRepository<ListingVariant, ListingVariantCriteria>
  implements ListingVariantRepository
{
  constructor(seed: readonly ListingVariant[] = []) {
    super(seed, listingVariantMatcher);
  }

  /** SKU uniqueness mirrors the pg UNIQUE constraint. */
  override async create(item: ListingVariant): Promise<ListingVariant> {
    for (const existing of this.items.values()) {
      if (existing.sku === item.sku) {
        throw new ConflictException(`A variant with sku '${item.sku}' already exists`);
      }
    }
    return super.create(item);
  }

  async decrementStock(id: string, quantity: number): Promise<ListingVariant> {
    const current = this.items.get(id);
    if (!current) {
      throw new BadRequestException(`Variant '${id}' does not exist`);
    }
    if (!current.isActive) {
      throw new BadRequestException(`Variant '${current.sku}' is not active`);
    }
    if (quantity <= 0 || quantity > current.quantity) {
      throw new BadRequestException(`Quantity must be between 1 and ${current.quantity}`);
    }
    const next = { ...current, quantity: current.quantity - quantity };
    this.items.set(id, next);
    return next;
  }

  async restock(id: string, quantity: number): Promise<ListingVariant> {
    const current = this.items.get(id);
    if (!current) {
      throw new BadRequestException(`Variant '${id}' does not exist`);
    }
    const next = { ...current, quantity: current.quantity + quantity };
    this.items.set(id, next);
    return next;
  }
}

export function createInMemoryListingVariantRepository(
  seed: readonly ListingVariant[] = []
): InMemoryListingVariantRepository {
  return new InMemoryListingVariantRepository(seed);
}

/* ----------------------------- buyer groups ----------------------------- */

export interface BuyerGroupCriteria {
  name?: string;
  active?: boolean;
}

export interface BuyerGroupRepository extends AsyncRepository<BuyerGroup, BuyerGroupCriteria> {}

export function buyerGroupMatcher(criteria: BuyerGroupCriteria): (group: BuyerGroup) => boolean {
  return (group) =>
    (!criteria.name || group.name === criteria.name) &&
    (criteria.active === undefined || group.isActive === criteria.active);
}

export class InMemoryBuyerGroupRepository
  extends InMemoryRepository<BuyerGroup, BuyerGroupCriteria>
  implements BuyerGroupRepository
{
  constructor(seed: readonly BuyerGroup[] = []) {
    super(seed, buyerGroupMatcher);
  }

  override async create(item: BuyerGroup): Promise<BuyerGroup> {
    for (const existing of this.items.values()) {
      if (existing.name === item.name) {
        throw new ConflictException(`A buyer group named '${item.name}' already exists`);
      }
    }
    return super.create(item);
  }
}

export function createInMemoryBuyerGroupRepository(
  seed: readonly BuyerGroup[] = []
): InMemoryBuyerGroupRepository {
  return new InMemoryBuyerGroupRepository(seed);
}

export interface BuyerGroupMembershipCriteria {
  groupId?: string;
  userId?: string;
}

export interface BuyerGroupMembershipRepository
  extends AsyncRepository<BuyerGroupMembership, BuyerGroupMembershipCriteria> {
  removeMembership(groupId: string, userId: string): Promise<boolean>;
}

export function buyerGroupMembershipMatcher(
  criteria: BuyerGroupMembershipCriteria
): (membership: BuyerGroupMembership) => boolean {
  return (membership) =>
    (!criteria.groupId || membership.groupId === criteria.groupId) &&
    (!criteria.userId || membership.userId === criteria.userId);
}

export class InMemoryBuyerGroupMembershipRepository
  extends InMemoryRepository<BuyerGroupMembership, BuyerGroupMembershipCriteria>
  implements BuyerGroupMembershipRepository
{
  constructor(seed: readonly BuyerGroupMembership[] = []) {
    super(seed, buyerGroupMembershipMatcher);
  }

  /** (group_id, user_id) uniqueness mirrors the pg UNIQUE constraint. */
  override async create(item: BuyerGroupMembership): Promise<BuyerGroupMembership> {
    for (const existing of this.items.values()) {
      if (existing.groupId === item.groupId && existing.userId === item.userId) {
        throw new ConflictException('The user is already a member of this buyer group');
      }
    }
    return super.create(item);
  }

  async removeMembership(groupId: string, userId: string): Promise<boolean> {
    const existing = await this.findOne({ groupId, userId });
    return existing ? this.remove(existing.id) : false;
  }
}

export function createInMemoryBuyerGroupMembershipRepository(
  seed: readonly BuyerGroupMembership[] = []
): InMemoryBuyerGroupMembershipRepository {
  return new InMemoryBuyerGroupMembershipRepository(seed);
}

/* ------------------------------ price lists ----------------------------- */

export interface PriceListCriteria {
  buyerGroupId?: string | null;
  active?: boolean;
}

export interface PriceListRepository extends AsyncRepository<PriceList, PriceListCriteria> {}

export function priceListMatcher(criteria: PriceListCriteria): (list: PriceList) => boolean {
  return (list) =>
    (criteria.buyerGroupId === undefined ||
      (criteria.buyerGroupId === null ? list.buyerGroupId === undefined : list.buyerGroupId === criteria.buyerGroupId)) &&
    (criteria.active === undefined || list.isActive === criteria.active);
}

export class InMemoryPriceListRepository
  extends InMemoryRepository<PriceList, PriceListCriteria>
  implements PriceListRepository
{
  constructor(seed: readonly PriceList[] = []) {
    super(seed, priceListMatcher);
  }

  override async create(item: PriceList): Promise<PriceList> {
    for (const existing of this.items.values()) {
      if (existing.name === item.name) {
        throw new ConflictException(`A price list named '${item.name}' already exists`);
      }
    }
    return super.create(item);
  }
}

export function createInMemoryPriceListRepository(
  seed: readonly PriceList[] = []
): InMemoryPriceListRepository {
  return new InMemoryPriceListRepository(seed);
}

export interface PriceListEntryCriteria {
  priceListId?: string;
  variantId?: string;
}

export interface PriceListEntryRepository
  extends AsyncRepository<PriceListEntry, PriceListEntryCriteria> {
  /** Insert-or-replace the price for (priceListId, variantId). */
  upsert(entry: PriceListEntry): Promise<PriceListEntry>;
}

export function priceListEntryMatcher(
  criteria: PriceListEntryCriteria
): (entry: PriceListEntry) => boolean {
  return (entry) =>
    (!criteria.priceListId || entry.priceListId === criteria.priceListId) &&
    (!criteria.variantId || entry.variantId === criteria.variantId);
}

export class InMemoryPriceListEntryRepository
  extends InMemoryRepository<PriceListEntry, PriceListEntryCriteria>
  implements PriceListEntryRepository
{
  constructor(seed: readonly PriceListEntry[] = []) {
    super(seed, priceListEntryMatcher);
  }

  async upsert(entry: PriceListEntry): Promise<PriceListEntry> {
    const existing = await this.findOne({ priceListId: entry.priceListId, variantId: entry.variantId });
    if (existing) {
      const next = { ...existing, priceKobo: entry.priceKobo };
      this.items.set(existing.id, next);
      return next;
    }
    return this.create(entry);
  }
}

export function createInMemoryPriceListEntryRepository(
  seed: readonly PriceListEntry[] = []
): InMemoryPriceListEntryRepository {
  return new InMemoryPriceListEntryRepository(seed);
}

/* ------------------------------- promotions ----------------------------- */

export interface PromotionCriteria {
  code?: string;
  automatic?: boolean;
  active?: boolean;
  listingId?: string;
  buyerGroupId?: string;
}

export interface PromotionRepository extends AsyncRepository<Promotion, PromotionCriteria> {
  /**
   * Guarded usage increment: succeeds only while the promotion is active and
   * (when a usage limit is set) below it; throws ConflictException when the
   * limit is exhausted so concurrent checkouts cannot overspend a coupon.
   */
  incrementUsed(id: string): Promise<Promotion>;
}

export function promotionMatcher(criteria: PromotionCriteria): (promotion: Promotion) => boolean {
  return (promotion) =>
    (!criteria.code || promotion.code === criteria.code) &&
    (criteria.automatic === undefined || promotion.automatic === criteria.automatic) &&
    (criteria.active === undefined || promotion.isActive === criteria.active) &&
    (!criteria.listingId || promotion.listingId === criteria.listingId) &&
    (!criteria.buyerGroupId || promotion.buyerGroupId === criteria.buyerGroupId);
}

export class InMemoryPromotionRepository
  extends InMemoryRepository<Promotion, PromotionCriteria>
  implements PromotionRepository
{
  constructor(seed: readonly Promotion[] = []) {
    super(seed, promotionMatcher);
  }

  override async create(item: Promotion): Promise<Promotion> {
    if (item.code) {
      for (const existing of this.items.values()) {
        if (existing.code === item.code) {
          throw new ConflictException(`A promotion with code '${item.code}' already exists`);
        }
      }
    }
    return super.create(item);
  }

  async incrementUsed(id: string): Promise<Promotion> {
    const current = this.items.get(id);
    if (!current) {
      throw new BadRequestException(`Promotion '${id}' does not exist`);
    }
    if (!current.isActive) {
      throw new ConflictException(`Promotion '${current.code ?? id}' is not active`);
    }
    if (current.usageLimit !== undefined && current.usedCount >= current.usageLimit) {
      throw new ConflictException(`Promotion '${current.code ?? id}' has reached its usage limit`);
    }
    const next = { ...current, usedCount: current.usedCount + 1 };
    this.items.set(id, next);
    return next;
  }
}

export function createInMemoryPromotionRepository(
  seed: readonly Promotion[] = []
): InMemoryPromotionRepository {
  return new InMemoryPromotionRepository(seed);
}

export interface PromotionRedemptionCriteria {
  promotionId?: string;
  orderId?: string;
}

export interface PromotionRedemptionRepository
  extends AsyncRepository<PromotionRedemption, PromotionRedemptionCriteria> {}

export function promotionRedemptionMatcher(
  criteria: PromotionRedemptionCriteria
): (redemption: PromotionRedemption) => boolean {
  return (redemption) =>
    (!criteria.promotionId || redemption.promotionId === criteria.promotionId) &&
    (!criteria.orderId || redemption.orderId === criteria.orderId);
}

export class InMemoryPromotionRedemptionRepository
  extends InMemoryRepository<PromotionRedemption, PromotionRedemptionCriteria>
  implements PromotionRedemptionRepository
{
  constructor(seed: readonly PromotionRedemption[] = []) {
    super(seed, promotionRedemptionMatcher);
  }

  /** (promotion_id, order_id) uniqueness mirrors the pg UNIQUE constraint. */
  override async create(item: PromotionRedemption): Promise<PromotionRedemption> {
    for (const existing of this.items.values()) {
      if (existing.promotionId === item.promotionId && existing.orderId === item.orderId) {
        throw new ConflictException('This promotion is already recorded on the order');
      }
    }
    return super.create(item);
  }
}

export function createInMemoryPromotionRedemptionRepository(
  seed: readonly PromotionRedemption[] = []
): InMemoryPromotionRedemptionRepository {
  return new InMemoryPromotionRedemptionRepository(seed);
}

/* --------------------------- order extensions --------------------------- */

export interface OrderExtensionCriteria {
  channel?: SalesChannel;
  variantId?: string;
  draftId?: string;
}

export interface OrderExtensionRepository
  extends AsyncRepository<OrderExtension, OrderExtensionCriteria> {}

export function orderExtensionMatcher(
  criteria: OrderExtensionCriteria
): (extension: OrderExtension) => boolean {
  return (extension) =>
    (!criteria.channel || extension.channel === criteria.channel) &&
    (!criteria.variantId || extension.variantId === criteria.variantId) &&
    (!criteria.draftId || extension.draftId === criteria.draftId);
}

export class InMemoryOrderExtensionRepository
  extends InMemoryRepository<OrderExtension, OrderExtensionCriteria>
  implements OrderExtensionRepository
{
  constructor(seed: readonly OrderExtension[] = []) {
    super(seed, orderExtensionMatcher);
  }
}

export function createInMemoryOrderExtensionRepository(
  seed: readonly OrderExtension[] = []
): InMemoryOrderExtensionRepository {
  return new InMemoryOrderExtensionRepository(seed);
}

/* ------------------------------ return requests ------------------------- */

export interface ReturnRequestCriteria {
  orderId?: string;
  buyerId?: string;
  status?: ReturnRequest['status'];
}

export interface ReturnRequestRepository
  extends AsyncRepository<ReturnRequest, ReturnRequestCriteria> {}

export function returnRequestMatcher(
  criteria: ReturnRequestCriteria
): (request: ReturnRequest) => boolean {
  return (request) =>
    (!criteria.orderId || request.orderId === criteria.orderId) &&
    (!criteria.buyerId || request.buyerId === criteria.buyerId) &&
    (!criteria.status || request.status === criteria.status);
}

export class InMemoryReturnRequestRepository
  extends InMemoryRepository<ReturnRequest, ReturnRequestCriteria>
  implements ReturnRequestRepository
{
  constructor(seed: readonly ReturnRequest[] = []) {
    super(seed, returnRequestMatcher);
  }
}

export function createInMemoryReturnRequestRepository(
  seed: readonly ReturnRequest[] = []
): InMemoryReturnRequestRepository {
  return new InMemoryReturnRequestRepository(seed);
}

/* ------------------------------ draft orders ---------------------------- */

export interface DraftOrderCriteria {
  buyerId?: string;
  sellerId?: string;
  status?: DraftOrder['status'];
  createdBy?: string;
}

export interface DraftOrderRepository extends AsyncRepository<DraftOrder, DraftOrderCriteria> {}

export function draftOrderMatcher(criteria: DraftOrderCriteria): (draft: DraftOrder) => boolean {
  return (draft) =>
    (!criteria.buyerId || draft.buyerId === criteria.buyerId) &&
    (!criteria.sellerId || draft.sellerId === criteria.sellerId) &&
    (!criteria.status || draft.status === criteria.status) &&
    (!criteria.createdBy || draft.createdBy === criteria.createdBy);
}

export class InMemoryDraftOrderRepository
  extends InMemoryRepository<DraftOrder, DraftOrderCriteria>
  implements DraftOrderRepository
{
  constructor(seed: readonly DraftOrder[] = []) {
    super(seed, draftOrderMatcher);
  }
}

export function createInMemoryDraftOrderRepository(
  seed: readonly DraftOrder[] = []
): InMemoryDraftOrderRepository {
  return new InMemoryDraftOrderRepository(seed);
}

/* ------------------- product reviews + seller ratings ------------------- */

export interface ProductReviewCriteria {
  listingId?: string;
  orderId?: string;
  buyerId?: string;
}

export interface ProductReviewRepository
  extends AsyncRepository<ProductReview, ProductReviewCriteria> {}

export function productReviewMatcher(
  criteria: ProductReviewCriteria
): (review: ProductReview) => boolean {
  return (review) =>
    (!criteria.listingId || review.listingId === criteria.listingId) &&
    (!criteria.orderId || review.orderId === criteria.orderId) &&
    (!criteria.buyerId || review.buyerId === criteria.buyerId);
}

export class InMemoryProductReviewRepository
  extends InMemoryRepository<ProductReview, ProductReviewCriteria>
  implements ProductReviewRepository
{
  constructor(seed: readonly ProductReview[] = []) {
    super(seed, productReviewMatcher);
  }

  /** (order_id, buyer_id) uniqueness mirrors the pg UNIQUE constraint. */
  override async create(item: ProductReview): Promise<ProductReview> {
    for (const existing of this.items.values()) {
      if (existing.orderId === item.orderId && existing.buyerId === item.buyerId) {
        throw new ConflictException('This order has already been reviewed by this buyer');
      }
    }
    return super.create(item);
  }
}

export function createInMemoryProductReviewRepository(
  seed: readonly ProductReview[] = []
): InMemoryProductReviewRepository {
  return new InMemoryProductReviewRepository(seed);
}

export interface SellerRatingCriteria {
  minReviews?: number;
}

export interface SellerRatingRepository extends AsyncRepository<SellerRating, SellerRatingCriteria> {
  /**
   * Materialized-aggregate update: adds one review to the seller's running
   * totals atomically (INSERT … ON CONFLICT on pg; check-and-set in memory).
   */
  applyReview(userId: string, rating: number): Promise<SellerRating>;
}

export function sellerRatingMatcher(criteria: SellerRatingCriteria): (rating: SellerRating) => boolean {
  return (rating) =>
    criteria.minReviews === undefined || rating.reviewCount >= criteria.minReviews;
}

export class InMemorySellerRatingRepository
  extends InMemoryRepository<SellerRating, SellerRatingCriteria>
  implements SellerRatingRepository
{
  constructor(seed: readonly SellerRating[] = []) {
    super(seed, sellerRatingMatcher);
  }

  async applyReview(userId: string, rating: number): Promise<SellerRating> {
    const current = this.items.get(userId);
    const reviewCount = (current?.reviewCount ?? 0) + 1;
    const ratingSum = (current?.ratingSum ?? 0) + rating;
    const next: SellerRating = {
      id: userId,
      userId,
      reviewCount,
      ratingSum,
      average: Math.round((ratingSum / reviewCount) * 100) / 100,
      updatedAt: new Date().toISOString()
    };
    this.items.set(userId, next);
    return next;
  }
}

export function createInMemorySellerRatingRepository(
  seed: readonly SellerRating[] = []
): InMemorySellerRatingRepository {
  return new InMemorySellerRatingRepository(seed);
}
