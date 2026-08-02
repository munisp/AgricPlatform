import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  AppliedPromotion,
  Promotion,
  PromotionEvaluation,
  PromotionRedemption,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  PROMOTION_REDEMPTION_REPOSITORY,
  PROMOTION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  PromotionRedemptionRepository,
  PromotionRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { BuyerGroupsService, assertBuyerGroupManager } from './buyer-groups.service.js';

export interface CreatePromotionInput {
  code?: string;
  name: string;
  kind: Promotion['kind'];
  /** percentage → basis points (10000 = 100%); fixed → kobo. */
  value: number;
  automatic?: boolean;
  minOrderKobo?: number;
  listingId?: string;
  buyerGroupId?: string;
  usageLimit?: number;
  startsAt?: string;
  endsAt?: string;
}

export interface UpdatePromotionInput {
  name?: string;
  value?: number;
  minOrderKobo?: number | null;
  listingId?: string | null;
  buyerGroupId?: string | null;
  usageLimit?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

export interface EvaluatePromotionInput {
  subtotalKobo: number;
  listingId: string;
  buyerId: string;
  /** Coupon code supplied at checkout (optional). */
  code?: string;
  at?: string;
}

/** Normalizes coupon codes for storage/lookup (case-insensitive coupons). */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Feature 2 (Wave M): promotions engine. Coupon-code and automatic
 * promotions with min-order-value, listing and buyer-group conditions, usage
 * limits and validity windows. Evaluation computes the discount; redemption
 * is recorded on the order with a guarded usage-count increment.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(PROMOTION_REPOSITORY) private readonly promotions: PromotionRepository,
    @Inject(PROMOTION_REDEMPTION_REPOSITORY) private readonly redemptions: PromotionRedemptionRepository,
    private readonly buyerGroups: BuyerGroupsService
  ) {}

  async listPromotions(): Promise<Promotion[]> {
    return this.promotions.all();
  }

  async getPromotion(id: string): Promise<Promotion> {
    return this.promotions.getById(id);
  }

  async createPromotion(input: CreatePromotionInput, actor: Pick<User, 'id' | 'roles'>): Promise<Promotion> {
    assertBuyerGroupManager(actor);
    const automatic = input.automatic ?? !input.code;
    if (!automatic && !input.code?.trim()) {
      throw new BadRequestException('A coupon code is required for a non-automatic promotion');
    }
    if (!input.name.trim()) {
      throw new BadRequestException('A promotion name is required');
    }
    this.assertValidValue(input.kind, input.value);
    if (input.buyerGroupId) {
      await this.buyerGroups.getGroup(input.buyerGroupId);
    }
    if (input.startsAt && input.endsAt && input.startsAt > input.endsAt) {
      throw new BadRequestException('Promotion starts_at must not be after ends_at');
    }
    const now = new Date().toISOString();
    const promotion: Promotion = {
      id: newId('promo'),
      code: input.code ? normalizeCode(input.code) : undefined,
      name: input.name.trim(),
      kind: input.kind,
      value: input.value,
      automatic,
      minOrderKobo: input.minOrderKobo,
      listingId: input.listingId,
      buyerGroupId: input.buyerGroupId,
      usageLimit: input.usageLimit,
      usedCount: 0,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.promotions.create(promotion);
    await this.events.publish('marketplace.promotion.created', { promotionId: created.id }, actor.id);
    return created;
  }

  async updatePromotion(
    id: string,
    patch: UpdatePromotionInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Promotion> {
    assertBuyerGroupManager(actor);
    const current = await this.promotions.getById(id);
    if (patch.value !== undefined) {
      this.assertValidValue(current.kind, patch.value);
    }
    const nullable = <K extends 'minOrderKobo' | 'listingId' | 'buyerGroupId' | 'usageLimit' | 'startsAt' | 'endsAt'>(
      key: K
    ): Partial<Promotion> =>
      patch[key] !== undefined ? { [key]: patch[key] === null ? undefined : patch[key] } : {};
    const updated = await this.promotions.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.value !== undefined ? { value: patch.value } : {}),
      ...nullable('minOrderKobo'),
      ...nullable('listingId'),
      ...nullable('buyerGroupId'),
      ...nullable('usageLimit'),
      ...nullable('startsAt'),
      ...nullable('endsAt'),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      updatedAt: new Date().toISOString()
    });
    await this.events.publish('marketplace.promotion.updated', { promotionId: id }, actor.id);
    return updated;
  }

  async redemptionsForOrder(orderId: string): Promise<PromotionRedemption[]> {
    return this.redemptions.find({ orderId });
  }

  /**
   * Computes the discount for a checkout context. All applicable automatic
   * promotions apply; a supplied coupon code applies when its conditions
   * hold, otherwise it is reported as rejected. Discounts stack in creation
   * order and are capped at the subtotal.
   */
  async evaluate(input: EvaluatePromotionInput): Promise<PromotionEvaluation> {
    const at = input.at ?? new Date().toISOString();
    if (input.subtotalKobo < 0 || !Number.isSafeInteger(input.subtotalKobo)) {
      throw new BadRequestException('Subtotal must be a non-negative kobo integer');
    }
    const buyerGroupIds = await this.buyerGroups.groupIdsForUser(input.buyerId);
    const applicable: Promotion[] = [];
    for (const promotion of await this.promotions.find({ automatic: true, active: true })) {
      if (this.conditionsHold(promotion, input, buyerGroupIds, at)) {
        applicable.push(promotion);
      }
    }
    let rejectedCode: PromotionEvaluation['rejectedCode'];
    if (input.code) {
      const code = normalizeCode(input.code);
      const promotion = await this.promotions.findOne({ code });
      if (!promotion) {
        rejectedCode = { code, reason: 'Unknown promotion code' };
      } else {
        const reason = this.rejectionReason(promotion, input, buyerGroupIds, at);
        if (reason) {
          rejectedCode = { code, reason };
        } else {
          applicable.push(promotion);
        }
      }
    }
    const applied: AppliedPromotion[] = [];
    let remaining = input.subtotalKobo;
    for (const promotion of applicable) {
      if (remaining <= 0) {
        break;
      }
      const raw =
        promotion.kind === 'percentage'
          ? Math.floor((input.subtotalKobo * promotion.value) / 10_000)
          : promotion.value;
      const discountKobo = Math.min(raw, remaining);
      if (discountKobo <= 0) {
        continue;
      }
      applied.push({
        promotionId: promotion.id,
        code: promotion.code,
        name: promotion.name,
        discountKobo
      });
      remaining -= discountKobo;
    }
    const discountKobo = applied.reduce((sum, item) => sum + item.discountKobo, 0);
    return {
      subtotalKobo: input.subtotalKobo,
      discountKobo,
      totalKobo: input.subtotalKobo - discountKobo,
      applied,
      rejectedCode
    };
  }

  /**
   * Records the evaluated promotions on an order: guarded usage-count
   * increment per promotion (usage limits hold under concurrency) plus a
   * redemption row (UNIQUE per (promotion, order) — replays are rejected).
   */
  async recordRedemptions(orderId: string, applied: readonly AppliedPromotion[]): Promise<PromotionRedemption[]> {
    const recorded: PromotionRedemption[] = [];
    for (const item of applied) {
      await this.promotions.incrementUsed(item.promotionId);
      recorded.push(
        await this.redemptions.create({
          id: newId('redemption'),
          promotionId: item.promotionId,
          orderId,
          discountKobo: item.discountKobo,
          createdAt: new Date().toISOString()
        })
      );
    }
    return recorded;
  }

  private conditionsHold(
    promotion: Promotion,
    input: EvaluatePromotionInput,
    buyerGroupIds: readonly string[],
    at: string
  ): boolean {
    return this.rejectionReason(promotion, input, buyerGroupIds, at) === undefined;
  }

  private rejectionReason(
    promotion: Promotion,
    input: EvaluatePromotionInput,
    buyerGroupIds: readonly string[],
    at: string
  ): string | undefined {
    if (!promotion.isActive) {
      return 'Promotion is not active';
    }
    if (promotion.startsAt && promotion.startsAt > at) {
      return 'Promotion has not started';
    }
    if (promotion.endsAt && promotion.endsAt < at) {
      return 'Promotion has expired';
    }
    if (promotion.usageLimit !== undefined && promotion.usedCount >= promotion.usageLimit) {
      return 'Promotion usage limit reached';
    }
    if (promotion.minOrderKobo !== undefined && input.subtotalKobo < promotion.minOrderKobo) {
      return `Order does not meet the minimum value of ${promotion.minOrderKobo} kobo`;
    }
    if (promotion.listingId && promotion.listingId !== input.listingId) {
      return 'Promotion does not apply to this listing';
    }
    if (promotion.buyerGroupId && !buyerGroupIds.includes(promotion.buyerGroupId)) {
      return 'Promotion is restricted to a buyer group';
    }
    return undefined;
  }

  private assertValidValue(kind: Promotion['kind'], value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException('Promotion value must be a positive integer');
    }
    if (kind === 'percentage' && value > 10_000) {
      throw new BadRequestException('Percentage promotions cannot exceed 10000 basis points (100%)');
    }
  }
}
