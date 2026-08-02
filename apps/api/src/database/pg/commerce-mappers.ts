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
import { num, ts, type RowMapper } from './pg-repository.base.js';

/**
 * Wave M commerce-depth row mappers (kept in a dedicated file so the shared
 * row-mappers.ts stays untouched for the parallel wave). Same conventions:
 * snake_case columns, timestamptz → ISO strings, numeric → number.
 */

function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

export const listingVariantMapper: RowMapper<ListingVariant> = {
  columns: [
    'id',
    'listing_id',
    'sku',
    'name',
    'attributes',
    'price_kobo',
    'quantity',
    'is_active',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    listingId: row.listing_id as string,
    sku: row.sku as string,
    name: row.name as string,
    attributes: (row.attributes as Record<string, string>) ?? {},
    priceKobo: num(row.price_kobo),
    quantity: num(row.quantity),
    isActive: row.is_active as boolean,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) => {
    const row = present(item, {
      id: 'id',
      listing_id: 'listingId',
      sku: 'sku',
      name: 'name',
      price_kobo: 'priceKobo',
      quantity: 'quantity',
      is_active: 'isActive',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    });
    if ('attributes' in item) {
      row.attributes = JSON.stringify(item.attributes ?? {});
    }
    return row;
  }
};

export const buyerGroupMapper: RowMapper<BuyerGroup> = {
  columns: ['id', 'name', 'description', 'is_active', 'created_at', 'updated_at'],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    isActive: row.is_active as boolean,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      description: 'description',
      is_active: 'isActive',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const buyerGroupMembershipMapper: RowMapper<BuyerGroupMembership> = {
  columns: ['id', 'group_id', 'user_id', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    groupId: row.group_id as string,
    userId: row.user_id as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, { id: 'id', group_id: 'groupId', user_id: 'userId', created_at: 'createdAt' })
};

export const priceListMapper: RowMapper<PriceList> = {
  columns: [
    'id',
    'name',
    'description',
    'buyer_group_id',
    'starts_at',
    'ends_at',
    'priority',
    'is_active',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    buyerGroupId: (row.buyer_group_id as string) ?? undefined,
    startsAt: row.starts_at ? ts(row.starts_at) : undefined,
    endsAt: row.ends_at ? ts(row.ends_at) : undefined,
    priority: num(row.priority),
    isActive: row.is_active as boolean,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      description: 'description',
      buyer_group_id: 'buyerGroupId',
      starts_at: 'startsAt',
      ends_at: 'endsAt',
      priority: 'priority',
      is_active: 'isActive',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const priceListEntryMapper: RowMapper<PriceListEntry> = {
  columns: ['id', 'price_list_id', 'variant_id', 'price_kobo'],
  fromRow: (row) => ({
    id: row.id as string,
    priceListId: row.price_list_id as string,
    variantId: row.variant_id as string,
    priceKobo: num(row.price_kobo)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      price_list_id: 'priceListId',
      variant_id: 'variantId',
      price_kobo: 'priceKobo'
    })
};

export const promotionMapper: RowMapper<Promotion> = {
  columns: [
    'id',
    'code',
    'name',
    'kind',
    'value',
    'automatic',
    'min_order_kobo',
    'listing_id',
    'buyer_group_id',
    'usage_limit',
    'used_count',
    'starts_at',
    'ends_at',
    'is_active',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    code: (row.code as string) ?? undefined,
    name: row.name as string,
    kind: row.kind as Promotion['kind'],
    value: num(row.value),
    automatic: row.automatic as boolean,
    minOrderKobo: row.min_order_kobo === null ? undefined : num(row.min_order_kobo),
    listingId: (row.listing_id as string) ?? undefined,
    buyerGroupId: (row.buyer_group_id as string) ?? undefined,
    usageLimit: row.usage_limit === null ? undefined : num(row.usage_limit),
    usedCount: num(row.used_count),
    startsAt: row.starts_at ? ts(row.starts_at) : undefined,
    endsAt: row.ends_at ? ts(row.ends_at) : undefined,
    isActive: row.is_active as boolean,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      code: 'code',
      name: 'name',
      kind: 'kind',
      value: 'value',
      automatic: 'automatic',
      min_order_kobo: 'minOrderKobo',
      listing_id: 'listingId',
      buyer_group_id: 'buyerGroupId',
      usage_limit: 'usageLimit',
      used_count: 'usedCount',
      starts_at: 'startsAt',
      ends_at: 'endsAt',
      is_active: 'isActive',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const promotionRedemptionMapper: RowMapper<PromotionRedemption> = {
  columns: ['id', 'promotion_id', 'order_id', 'discount_kobo', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    promotionId: row.promotion_id as string,
    orderId: row.order_id as string,
    discountKobo: num(row.discount_kobo),
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      promotion_id: 'promotionId',
      order_id: 'orderId',
      discount_kobo: 'discountKobo',
      created_at: 'createdAt'
    })
};

export const orderExtensionMapper: RowMapper<OrderExtension> = {
  columns: [
    'order_id',
    'variant_id',
    'channel',
    'unit_price_kobo',
    'subtotal_kobo',
    'discount_kobo',
    'total_kobo',
    'draft_id',
    'created_by',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.order_id as string,
    orderId: row.order_id as string,
    variantId: (row.variant_id as string) ?? undefined,
    channel: row.channel as OrderExtension['channel'],
    unitPriceKobo: num(row.unit_price_kobo),
    subtotalKobo: num(row.subtotal_kobo),
    discountKobo: num(row.discount_kobo),
    totalKobo: num(row.total_kobo),
    draftId: (row.draft_id as string) ?? undefined,
    createdBy: (row.created_by as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      order_id: 'orderId',
      variant_id: 'variantId',
      channel: 'channel',
      unit_price_kobo: 'unitPriceKobo',
      subtotal_kobo: 'subtotalKobo',
      discount_kobo: 'discountKobo',
      total_kobo: 'totalKobo',
      draft_id: 'draftId',
      created_by: 'createdBy',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const returnRequestMapper: RowMapper<ReturnRequest> = {
  columns: [
    'id',
    'order_id',
    'buyer_id',
    'reason',
    'status',
    'restock',
    'created_at',
    'updated_at',
    'resolved_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    orderId: row.order_id as string,
    buyerId: row.buyer_id as string,
    reason: row.reason as string,
    status: row.status as ReturnRequest['status'],
    restock: row.restock as boolean,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    resolvedAt: row.resolved_at ? ts(row.resolved_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      order_id: 'orderId',
      buyer_id: 'buyerId',
      reason: 'reason',
      status: 'status',
      restock: 'restock',
      created_at: 'createdAt',
      updated_at: 'updatedAt',
      resolved_at: 'resolvedAt'
    })
};

export const draftOrderMapper: RowMapper<DraftOrder> = {
  columns: [
    'id',
    'listing_id',
    'variant_id',
    'buyer_id',
    'seller_id',
    'quantity',
    'unit_price_kobo',
    'status',
    'order_id',
    'created_by',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    listingId: row.listing_id as string,
    variantId: (row.variant_id as string) ?? undefined,
    buyerId: row.buyer_id as string,
    sellerId: row.seller_id as string,
    quantity: num(row.quantity),
    unitPriceKobo: num(row.unit_price_kobo),
    status: row.status as DraftOrder['status'],
    orderId: (row.order_id as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      listing_id: 'listingId',
      variant_id: 'variantId',
      buyer_id: 'buyerId',
      seller_id: 'sellerId',
      quantity: 'quantity',
      unit_price_kobo: 'unitPriceKobo',
      status: 'status',
      order_id: 'orderId',
      created_by: 'createdBy',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const productReviewMapper: RowMapper<ProductReview> = {
  columns: ['id', 'listing_id', 'order_id', 'buyer_id', 'rating', 'comment', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    listingId: row.listing_id as string,
    orderId: row.order_id as string,
    buyerId: row.buyer_id as string,
    rating: num(row.rating),
    comment: (row.comment as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      listing_id: 'listingId',
      order_id: 'orderId',
      buyer_id: 'buyerId',
      rating: 'rating',
      comment: 'comment',
      created_at: 'createdAt'
    })
};

export const sellerRatingMapper: RowMapper<SellerRating> = {
  columns: ['user_id', 'review_count', 'rating_sum', 'average', 'updated_at'],
  fromRow: (row) => ({
    id: row.user_id as string,
    userId: row.user_id as string,
    reviewCount: num(row.review_count),
    ratingSum: num(row.rating_sum),
    average: num(row.average),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      user_id: 'userId',
      review_count: 'reviewCount',
      rating_sum: 'ratingSum',
      average: 'average',
      updated_at: 'updatedAt'
    })
};
