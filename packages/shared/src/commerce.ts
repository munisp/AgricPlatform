/**
 * Wave M marketplace commerce depth (Medusa-pattern innovations adopted
 * natively): listing variants/SKUs, promotions, price lists, buyer groups,
 * order edit/cancel-with-restock, RMA returns, draft orders, sales channels,
 * verified-purchase reviews with seller ratings, and seller analytics.
 *
 * Money is integer kobo everywhere in this file (the funds-integrity
 * contract). Order rows still carry the legacy `totalNaira` field; the
 * commerce checkout settles orders in whole naira by absorbing any sub-naira
 * remainder into the recorded discount (buyer is never overcharged), so
 * `totalNaira * 100` is always an exact kobo integer for escrow.
 */

export const SALES_CHANNELS = ['web', 'mobile', 'agent'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

/* --------------------------- 1. Listing variants ------------------------ */

export interface ListingVariant {
  id: string;
  listingId: string;
  /** Seller-scoped stock keeping unit (globally unique). */
  sku: string;
  /** Human label, e.g. "Grade A — 50kg bag". */
  name: string;
  /** Structured option values, e.g. { grade: 'A', bagSizeKg: '50' }. */
  attributes: Record<string, string>;
  priceKobo: number;
  quantity: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ----------------------------- 4. Buyer groups -------------------------- */

export interface BuyerGroup {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerGroupMembership {
  id: string;
  groupId: string;
  userId: string;
  createdAt: string;
}

/* ------------------------------ 3. Price lists -------------------------- */

export interface PriceList {
  id: string;
  name: string;
  description?: string;
  /** When set, only members of this buyer group see these prices. */
  buyerGroupId?: string;
  startsAt?: string;
  endsAt?: string;
  /** Higher priority wins when several lists apply at the same price. */
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriceListEntry {
  id: string;
  priceListId: string;
  variantId: string;
  priceKobo: number;
}

export interface ResolvedPrice {
  variantId: string;
  priceKobo: number;
  /** Set when a price list overrode the variant list price. */
  priceListId?: string;
  listPriceKobo: number;
}

/* ------------------------------ 2. Promotions --------------------------- */

export const PROMOTION_KINDS = ['percentage', 'fixed'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export interface Promotion {
  id: string;
  /** Coupon code; null/undefined means an automatic promotion. */
  code?: string;
  name: string;
  kind: PromotionKind;
  /** percentage → basis points (10000 = 100%); fixed → kobo off the order. */
  value: number;
  automatic: boolean;
  minOrderKobo?: number;
  listingId?: string;
  buyerGroupId?: string;
  usageLimit?: number;
  usedCount: number;
  startsAt?: string;
  endsAt?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionRedemption {
  id: string;
  promotionId: string;
  orderId: string;
  discountKobo: number;
  createdAt: string;
}

export interface AppliedPromotion {
  promotionId: string;
  code?: string;
  name: string;
  discountKobo: number;
}

export interface PromotionEvaluation {
  subtotalKobo: number;
  discountKobo: number;
  totalKobo: number;
  applied: AppliedPromotion[];
  /** Set when a supplied coupon code was rejected (with the reason). */
  rejectedCode?: { code: string; reason: string };
}

/* --------------------- 5/7/8. Order extensions -------------------------- */

/**
 * Commerce attributes that ride alongside the marketplace order row (kept in
 * a side table so the shared Order contract stays untouched).
 */
export interface OrderExtension {
  /** Repository identity — always equal to orderId (1:1 side table). */
  id: string;
  orderId: string;
  variantId?: string;
  channel: SalesChannel;
  unitPriceKobo: number;
  subtotalKobo: number;
  discountKobo: number;
  /** Final charged amount in kobo (=== order.totalNaira * 100). */
  totalKobo: number;
  /** Set when the order originated from a draft order. */
  draftId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------ 6. RMA / returns ------------------------ */

export const RETURN_STATUSES = ['requested', 'approved', 'received', 'refunded', 'rejected'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export interface ReturnRequest {
  id: string;
  orderId: string;
  buyerId: string;
  reason: string;
  status: ReturnStatus;
  /** When true, stock is restored to the variant/listing on 'received'. */
  restock: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/* ---------------------------- 7. Draft orders --------------------------- */

export const DRAFT_ORDER_STATUSES = ['open', 'confirmed', 'discarded'] as const;
export type DraftOrderStatus = (typeof DRAFT_ORDER_STATUSES)[number];

export interface DraftOrder {
  id: string;
  listingId: string;
  variantId?: string;
  buyerId: string;
  sellerId: string;
  quantity: number;
  unitPriceKobo: number;
  status: DraftOrderStatus;
  /** Filled when the buyer confirms and the real order is placed. */
  orderId?: string;
  /** Agent/admin who created the draft on behalf of the buyer. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------- 9. Verified reviews & seller ratings -------------- */

export interface ProductReview {
  id: string;
  listingId: string;
  orderId: string;
  buyerId: string;
  rating: number; // 1..5
  comment?: string;
  createdAt: string;
}

/** Materialized per-seller aggregate, updated transactionally with reviews. */
export interface SellerRating {
  /** Repository identity — always equal to userId. */
  id: string;
  userId: string;
  reviewCount: number;
  ratingSum: number;
  /** ratingSum / reviewCount (0 when no reviews). */
  average: number;
  updatedAt: string;
}

/* --------------------------- 10. Seller analytics ----------------------- */

export interface TopVariantStat {
  variantId: string;
  sku: string;
  name: string;
  unitsSold: number;
  revenueKobo: number;
}

export interface SellerAnalytics {
  sellerId: string;
  /** Gross merchandise value of completed orders, integer kobo. */
  revenueKobo: number;
  orderCounts: Record<string, number>;
  totalOrders: number;
  /** Share of non-cancelled orders that reached delivery (0..1). */
  fulfilmentRate: number;
  /** Share of orders that entered dispute (0..1). */
  disputeRate: number;
  /** Share of fulfilled orders with a return request (0..1). */
  returnRate: number;
  topVariants: TopVariantStat[];
  sellerRating?: SellerRating;
}
