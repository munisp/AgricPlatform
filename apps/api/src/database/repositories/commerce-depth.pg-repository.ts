import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  BuyerGroup,
  BuyerGroupMembership,
  DraftOrder,
  ListingVariant,
  OrderExtension,
  PriceList,
  PriceListEntry,
  ProductReview,
  Promotion,
  PromotionRedemption,
  ReturnRequest,
  SellerRating
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  mapPgError,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  buyerGroupMapper,
  buyerGroupMembershipMapper,
  draftOrderMapper,
  listingVariantMapper,
  orderExtensionMapper,
  priceListEntryMapper,
  priceListMapper,
  productReviewMapper,
  promotionMapper,
  promotionRedemptionMapper,
  returnRequestMapper,
  sellerRatingMapper
} from '../pg/commerce-mappers.js';
import type {
  BuyerGroupCriteria,
  BuyerGroupMembershipCriteria,
  BuyerGroupRepository,
  BuyerGroupMembershipRepository,
  DraftOrderCriteria,
  DraftOrderRepository,
  ListingVariantCriteria,
  ListingVariantRepository,
  OrderExtensionCriteria,
  OrderExtensionRepository,
  PriceListCriteria,
  PriceListEntryCriteria,
  PriceListEntryRepository,
  PriceListRepository,
  ProductReviewCriteria,
  ProductReviewRepository,
  PromotionCriteria,
  PromotionRedemptionCriteria,
  PromotionRedemptionRepository,
  PromotionRepository,
  ReturnRequestCriteria,
  ReturnRequestRepository,
  SellerRatingCriteria,
  SellerRatingRepository
} from './commerce-depth.repository.js';

/** Wave M commerce-depth pg repositories (migration 017 tables). */

/* --------------------------- listing variants --------------------------- */

export function listingVariantCriteriaSql(criteria: ListingVariantCriteria): WhereClause {
  return composeWhere(
    eq('listing_id', criteria.listingId),
    eq('sku', criteria.sku),
    criteria.active === undefined ? null : eq('is_active', criteria.active)
  );
}

export class PgListingVariantRepository
  extends PgRepositoryBase<ListingVariant, ListingVariantCriteria>
  implements ListingVariantRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.listing_variants',
      mapper: listingVariantMapper,
      criteria: listingVariantCriteriaSql
    });
  }

  /**
   * Atomic per-variant stock decrement (same oversell guard as the listing
   * conditional UPDATE): 0 rows → re-read to surface the precise reason.
   */
  async decrementStock(id: string, quantity: number): Promise<ListingVariant> {
    const result = await this.pool.query(
      `UPDATE marketplace.listing_variants
          SET quantity = quantity - $2, updated_at = now()
        WHERE id = $1 AND is_active AND quantity >= $2 AND $2 > 0
        RETURNING ${listingVariantMapper.columns.join(', ')}`,
      [id, quantity]
    );
    if (!result.rows[0]) {
      const current = await this.pool.query(
        `SELECT is_active, quantity, sku FROM marketplace.listing_variants WHERE id = $1`,
        [id]
      );
      const row = current.rows[0] as { is_active: boolean; quantity: number; sku: string } | undefined;
      if (!row) {
        throw new BadRequestException(`Variant '${id}' does not exist`);
      }
      if (!row.is_active) {
        throw new BadRequestException(`Variant '${row.sku}' is not active`);
      }
      throw new BadRequestException(`Quantity must be between 1 and ${row.quantity}`);
    }
    return listingVariantMapper.fromRow(result.rows[0]);
  }

  /** Atomic stock increment (order cancellation / RMA restock). */
  async restock(id: string, quantity: number): Promise<ListingVariant> {
    const result = await this.pool.query(
      `UPDATE marketplace.listing_variants
          SET quantity = quantity + $2, updated_at = now()
        WHERE id = $1
        RETURNING ${listingVariantMapper.columns.join(', ')}`,
      [id, quantity]
    );
    if (!result.rows[0]) {
      throw new BadRequestException(`Variant '${id}' does not exist`);
    }
    return listingVariantMapper.fromRow(result.rows[0]);
  }
}

/* ----------------------------- buyer groups ----------------------------- */

export function buyerGroupCriteriaSql(criteria: BuyerGroupCriteria): WhereClause {
  return composeWhere(
    eq('name', criteria.name),
    criteria.active === undefined ? null : eq('is_active', criteria.active)
  );
}

export class PgBuyerGroupRepository
  extends PgRepositoryBase<BuyerGroup, BuyerGroupCriteria>
  implements BuyerGroupRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.buyer_groups', mapper: buyerGroupMapper, criteria: buyerGroupCriteriaSql });
  }
}

export function buyerGroupMembershipCriteriaSql(criteria: BuyerGroupMembershipCriteria): WhereClause {
  return composeWhere(eq('group_id', criteria.groupId), eq('user_id', criteria.userId));
}

export class PgBuyerGroupMembershipRepository
  extends PgRepositoryBase<BuyerGroupMembership, BuyerGroupMembershipCriteria>
  implements BuyerGroupMembershipRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.buyer_group_memberships',
      mapper: buyerGroupMembershipMapper,
      criteria: buyerGroupMembershipCriteriaSql
    });
  }

  async removeMembership(groupId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM marketplace.buyer_group_memberships WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/* ------------------------------ price lists ----------------------------- */

export function priceListCriteriaSql(criteria: PriceListCriteria): WhereClause {
  return composeWhere(
    criteria.buyerGroupId === undefined
      ? null
      : criteria.buyerGroupId === null
        ? { where: 'buyer_group_id IS NULL', params: [] }
        : eq('buyer_group_id', criteria.buyerGroupId),
    criteria.active === undefined ? null : eq('is_active', criteria.active)
  );
}

export class PgPriceListRepository
  extends PgRepositoryBase<PriceList, PriceListCriteria>
  implements PriceListRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.price_lists', mapper: priceListMapper, criteria: priceListCriteriaSql });
  }
}

export function priceListEntryCriteriaSql(criteria: PriceListEntryCriteria): WhereClause {
  return composeWhere(eq('price_list_id', criteria.priceListId), eq('variant_id', criteria.variantId));
}

export class PgPriceListEntryRepository
  extends PgRepositoryBase<PriceListEntry, PriceListEntryCriteria>
  implements PriceListEntryRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.price_list_entries',
      mapper: priceListEntryMapper,
      criteria: priceListEntryCriteriaSql
    });
  }

  /** INSERT … ON CONFLICT (price_list_id, variant_id) upsert. */
  async upsert(entry: PriceListEntry): Promise<PriceListEntry> {
    const result = await this.pool.query(
      `INSERT INTO marketplace.price_list_entries (id, price_list_id, variant_id, price_kobo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (price_list_id, variant_id)
       DO UPDATE SET price_kobo = EXCLUDED.price_kobo
       RETURNING ${priceListEntryMapper.columns.join(', ')}`,
      [entry.id, entry.priceListId, entry.variantId, entry.priceKobo]
    );
    return priceListEntryMapper.fromRow(result.rows[0]);
  }
}

/* ------------------------------- promotions ----------------------------- */

export function promotionCriteriaSql(criteria: PromotionCriteria): WhereClause {
  return composeWhere(
    eq('code', criteria.code),
    criteria.automatic === undefined ? null : eq('automatic', criteria.automatic),
    criteria.active === undefined ? null : eq('is_active', criteria.active),
    eq('listing_id', criteria.listingId),
    eq('buyer_group_id', criteria.buyerGroupId)
  );
}

export class PgPromotionRepository
  extends PgRepositoryBase<Promotion, PromotionCriteria>
  implements PromotionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.promotions', mapper: promotionMapper, criteria: promotionCriteriaSql });
  }

  /**
   * Guarded usage increment (funds-integrity pattern): the conditional
   * UPDATE caps redemptions at usage_limit under concurrency; 0 rows →
   * re-read to distinguish inactive from exhausted.
   */
  async incrementUsed(id: string): Promise<Promotion> {
    const result = await this.pool.query(
      `UPDATE marketplace.promotions
          SET used_count = used_count + 1, updated_at = now()
        WHERE id = $1 AND is_active
          AND (usage_limit IS NULL OR used_count < usage_limit)
        RETURNING ${promotionMapper.columns.join(', ')}`,
      [id]
    );
    if (!result.rows[0]) {
      const current = await this.pool.query(
        `SELECT code, is_active FROM marketplace.promotions WHERE id = $1`,
        [id]
      );
      const row = current.rows[0] as { code: string | null; is_active: boolean } | undefined;
      if (!row) {
        throw new BadRequestException(`Promotion '${id}' does not exist`);
      }
      if (!row.is_active) {
        throw new ConflictException(`Promotion '${row.code ?? id}' is not active`);
      }
      throw new ConflictException(`Promotion '${row.code ?? id}' has reached its usage limit`);
    }
    return promotionMapper.fromRow(result.rows[0]);
  }
}

export function promotionRedemptionCriteriaSql(criteria: PromotionRedemptionCriteria): WhereClause {
  return composeWhere(eq('promotion_id', criteria.promotionId), eq('order_id', criteria.orderId));
}

export class PgPromotionRedemptionRepository
  extends PgRepositoryBase<PromotionRedemption, PromotionRedemptionCriteria>
  implements PromotionRedemptionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.promotion_redemptions',
      mapper: promotionRedemptionMapper,
      criteria: promotionRedemptionCriteriaSql
    });
  }
}

/* --------------------------- order extensions --------------------------- */

export function orderExtensionCriteriaSql(criteria: OrderExtensionCriteria): WhereClause {
  return composeWhere(
    eq('channel', criteria.channel),
    eq('variant_id', criteria.variantId),
    eq('draft_id', criteria.draftId)
  );
}

/**
 * order_extensions is keyed by order_id (no id column), so the identity
 * lookups are overridden against the natural key.
 */
export class PgOrderExtensionRepository
  extends PgRepositoryBase<OrderExtension, OrderExtensionCriteria>
  implements OrderExtensionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.order_extensions',
      mapper: orderExtensionMapper,
      criteria: orderExtensionCriteriaSql
    });
  }

  override async findById(orderId: string): Promise<OrderExtension | undefined> {
    const result = await this.pool.query(
      `SELECT ${orderExtensionMapper.columns.join(', ')} FROM marketplace.order_extensions WHERE order_id = $1`,
      [orderId]
    );
    return result.rows[0] ? orderExtensionMapper.fromRow(result.rows[0]) : undefined;
  }

  override async getById(orderId: string): Promise<OrderExtension> {
    const item = await this.findById(orderId);
    if (!item) {
      throw new NotFoundException(`Resource with id '${orderId}' not found`);
    }
    return item;
  }

  override async update(orderId: string, patch: Partial<OrderExtension>): Promise<OrderExtension> {
    const row = orderExtensionMapper.toRow(patch as OrderExtension);
    const columns = Object.keys(row).filter((column) => column !== 'order_id');
    if (columns.length === 0) {
      return this.getById(orderId);
    }
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const result = await this.pool.query(
      `UPDATE marketplace.order_extensions SET ${assignments} WHERE order_id = $1
       RETURNING ${orderExtensionMapper.columns.join(', ')}`,
      [orderId, ...columns.map((column) => row[column])]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Resource with id '${orderId}' not found`);
    }
    return orderExtensionMapper.fromRow(result.rows[0]);
  }

  override async remove(orderId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM marketplace.order_extensions WHERE order_id = $1`,
      [orderId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/* ------------------------------ return requests ------------------------- */

export function returnRequestCriteriaSql(criteria: ReturnRequestCriteria): WhereClause {
  return composeWhere(
    eq('order_id', criteria.orderId),
    eq('buyer_id', criteria.buyerId),
    eq('status', criteria.status)
  );
}

export class PgReturnRequestRepository
  extends PgRepositoryBase<ReturnRequest, ReturnRequestCriteria>
  implements ReturnRequestRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.return_requests',
      mapper: returnRequestMapper,
      criteria: returnRequestCriteriaSql
    });
  }
}

/* ------------------------------ draft orders ---------------------------- */

export function draftOrderCriteriaSql(criteria: DraftOrderCriteria): WhereClause {
  return composeWhere(
    eq('buyer_id', criteria.buyerId),
    eq('seller_id', criteria.sellerId),
    eq('status', criteria.status),
    eq('created_by', criteria.createdBy)
  );
}

export class PgDraftOrderRepository
  extends PgRepositoryBase<DraftOrder, DraftOrderCriteria>
  implements DraftOrderRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.draft_orders', mapper: draftOrderMapper, criteria: draftOrderCriteriaSql });
  }
}

/* ------------------- product reviews + seller ratings ------------------- */

export function productReviewCriteriaSql(criteria: ProductReviewCriteria): WhereClause {
  return composeWhere(
    eq('listing_id', criteria.listingId),
    eq('order_id', criteria.orderId),
    eq('buyer_id', criteria.buyerId)
  );
}

export class PgProductReviewRepository
  extends PgRepositoryBase<ProductReview, ProductReviewCriteria>
  implements ProductReviewRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.product_reviews',
      mapper: productReviewMapper,
      criteria: productReviewCriteriaSql
    });
  }
}

export function sellerRatingCriteriaSql(criteria: SellerRatingCriteria): WhereClause {
  return composeWhere(
    criteria.minReviews === undefined
      ? null
      : { where: 'review_count >= $1', params: [criteria.minReviews] }
  );
}

/**
 * seller_ratings is keyed by user_id (no id column); identity lookups are
 * overridden against the natural key.
 */
export class PgSellerRatingRepository
  extends PgRepositoryBase<SellerRating, SellerRatingCriteria>
  implements SellerRatingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.seller_ratings',
      mapper: sellerRatingMapper,
      criteria: sellerRatingCriteriaSql
    });
  }

  override async findById(userId: string): Promise<SellerRating | undefined> {
    const result = await this.pool.query(
      `SELECT ${sellerRatingMapper.columns.join(', ')} FROM marketplace.seller_ratings WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? sellerRatingMapper.fromRow(result.rows[0]) : undefined;
  }

  override async getById(userId: string): Promise<SellerRating> {
    const item = await this.findById(userId);
    if (!item) {
      throw new NotFoundException(`Resource with id '${userId}' not found`);
    }
    return item;
  }

  /**
   * Atomic materialized-aggregate update: a single INSERT … ON CONFLICT
   * statement so concurrent reviews never lose increments.
   */
  async applyReview(userId: string, rating: number): Promise<SellerRating> {
    try {
      const result = await this.pool.query(
        `INSERT INTO marketplace.seller_ratings (user_id, review_count, rating_sum, average, updated_at)
         VALUES ($1, 1, $2, $2, now())
         ON CONFLICT (user_id) DO UPDATE
            SET review_count = marketplace.seller_ratings.review_count + 1,
                rating_sum = marketplace.seller_ratings.rating_sum + EXCLUDED.rating_sum,
                average = ROUND(
                  (marketplace.seller_ratings.rating_sum + EXCLUDED.rating_sum)::numeric
                  / (marketplace.seller_ratings.review_count + 1), 2),
                updated_at = now()
         RETURNING ${sellerRatingMapper.columns.join(', ')}`,
        [userId, rating]
      );
      return sellerRatingMapper.fromRow(result.rows[0]);
    } catch (error) {
      mapPgError(error);
    }
  }
}

/* -------------------------------- factories ----------------------------- */

export function createPgListingVariantRepository(pool: pg.Pool): PgListingVariantRepository {
  return new PgListingVariantRepository(pool);
}

export function createPgBuyerGroupRepository(pool: pg.Pool): PgBuyerGroupRepository {
  return new PgBuyerGroupRepository(pool);
}

export function createPgBuyerGroupMembershipRepository(pool: pg.Pool): PgBuyerGroupMembershipRepository {
  return new PgBuyerGroupMembershipRepository(pool);
}

export function createPgPriceListRepository(pool: pg.Pool): PgPriceListRepository {
  return new PgPriceListRepository(pool);
}

export function createPgPriceListEntryRepository(pool: pg.Pool): PgPriceListEntryRepository {
  return new PgPriceListEntryRepository(pool);
}

export function createPgPromotionRepository(pool: pg.Pool): PgPromotionRepository {
  return new PgPromotionRepository(pool);
}

export function createPgPromotionRedemptionRepository(pool: pg.Pool): PgPromotionRedemptionRepository {
  return new PgPromotionRedemptionRepository(pool);
}

export function createPgOrderExtensionRepository(pool: pg.Pool): PgOrderExtensionRepository {
  return new PgOrderExtensionRepository(pool);
}

export function createPgReturnRequestRepository(pool: pg.Pool): PgReturnRequestRepository {
  return new PgReturnRequestRepository(pool);
}

export function createPgDraftOrderRepository(pool: pg.Pool): PgDraftOrderRepository {
  return new PgDraftOrderRepository(pool);
}

export function createPgProductReviewRepository(pool: pg.Pool): PgProductReviewRepository {
  return new PgProductReviewRepository(pool);
}

export function createPgSellerRatingRepository(pool: pg.Pool): PgSellerRatingRepository {
  return new PgSellerRatingRepository(pool);
}
