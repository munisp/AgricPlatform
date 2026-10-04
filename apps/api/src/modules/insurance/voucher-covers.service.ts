import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit
} from '@nestjs/common';
import type { DomainEvent, DomainEventsService } from '../../core/domain-events.service.js';
import type { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { newId } from '../../common/async-repository.js';
import type { User } from '@agric-platform/shared';
import {
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  VOUCHER_COVER_REPOSITORY,
  VOUCHER_PROGRAMME_RIDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { InputVoucherProgrammeRepository } from '../../database/repositories/input-voucher.repository.js';
import type {
  VoucherCoverCriteria,
  VoucherCoverRecord,
  VoucherCoverRepository,
  VoucherProgrammeRiderRecord,
  VoucherProgrammeRiderRepository
} from '../../database/repositories/voucher-cover.repository.js';

export interface QuoteRiderInput {
  productCode: string;
  sumInsuredKobo: number;
  premiumRateBps: number;
  floodBand: 'low' | 'medium' | 'high';
}

/**
 * Voucher-cover riders (Stage 27 innovation 19): an input-voucher
 * programme can carry a parametric insurance rider; each redeemed voucher
 * binds a cover, and insurance trigger/payout events project the cover
 * lifecycle (bound → triggered → paid).
 */
@Injectable()
export class VoucherCoversService implements OnModuleInit {
  private readonly logger = new Logger(VoucherCoversService.name);

  constructor(
    @Inject(INPUT_VOUCHER_PROGRAMME_REPOSITORY)
    private readonly programmes: InputVoucherProgrammeRepository,
    @Inject(VOUCHER_PROGRAMME_RIDER_REPOSITORY)
    private readonly riders: VoucherProgrammeRiderRepository,
    @Inject(VOUCHER_COVER_REPOSITORY)
    private readonly covers: VoucherCoverRepository,
    private readonly events: DomainEventsService,
    private readonly telemetry?: TelemetryService
  ) {}

  onModuleInit(): void {
    this.events.on('insurance.trigger.fired', (event) => {
      void this.projectTriggered(event);
    });
    this.events.on('insurance.payout.settled', (event) => {
      void this.projectPaid(event);
    });
  }

  // ---------------------------------------------------------------- riders

  /**
   * Quotes and attaches a rider to a programme (admin workflow). Premium is
   * deterministic: sumInsured × rate/10_000, flood-band adjusted.
   */
  async quoteRider(programmeId: string, input: QuoteRiderInput, actorId: string): Promise<VoucherProgrammeRiderRecord> {
    const programme = await this.programmes.findById(programmeId);
    if (!programme) {
      throw new NotFoundException(`Programme '${programmeId}' not found`);
    }
    const bandMultiplier = { low: 1, medium: 1.25, high: 1.6 }[input.floodBand];
    const premiumKobo = Math.round((input.sumInsuredKobo * input.premiumRateBps * bandMultiplier) / 10_000);
    const existing = await this.riders.findByProgrammeId(programmeId);
    const rider: VoucherProgrammeRiderRecord = {
      id: existing?.id ?? newId('rider'),
      programmeId,
      productCode: input.productCode,
      sumInsuredKobo: input.sumInsuredKobo,
      premiumRateBps: input.premiumRateBps,
      floodBand: input.floodBand,
      premiumKobo,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.riders.upsert(rider);
    await this.events.publish(
      'insurance.voucher_cover.quoted',
      {
        riderId: rider.id,
        programmeId: rider.programmeId,
        productCode: rider.productCode,
        sumInsuredKobo: rider.sumInsuredKobo,
        premiumRateBps: rider.premiumRateBps,
        floodBand: rider.floodBand,
        premiumKobo
      },
      actorId
    );
    this.telemetry?.increment('insurance.voucher_riders_total', 1, {
      programme_id: rider.programmeId,
      trigger_type: rider.productCode
    });
    return rider;
  }

  async getRider(programmeId: string): Promise<VoucherProgrammeRiderRecord> {
    const programme = await this.programmes.findById(programmeId);
    if (!programme) {
      throw new NotFoundException(`Programme '${programmeId}' not found`);
    }
    const rider = await this.riders.findByProgrammeId(programmeId);
    if (!rider) {
      throw new NotFoundException(`Programme '${programmeId}' has no insurance rider`);
    }
    return rider;
  }

  // ---------------------------------------------------------------- covers

  /** Farmer-facing cover status (farmer themself, or an authorised reviewer). */
  async getCover(id: string, actor: User): Promise<VoucherCoverRecord> {
    const cover = await this.covers.findById(id);
    if (!cover) {
      throw new NotFoundException(`Voucher cover '${id}' not found`);
    }
    const reviewer = (['admin', 'regulator', 'donor'] as const).some((role) => actor.roles.includes(role));
    if (cover.farmerId !== actor.id && !reviewer) {
      throw new ForbiddenException('Only the covered farmer or an authorised reviewer can read this cover');
    }
    return cover;
  }

  listCovers(criteria: VoucherCoverCriteria): Promise<VoucherCoverRecord[]> {
    return this.covers.find(criteria);
  }

  // ------------------------------------------------------------- projector

  /**
   * bound → triggered when the underlying policy's trigger fires. Idempotent:
   * a duplicate event finds the cover already triggered and no-ops; a cover
   * for another lifecycle state is left untouched.
   */
  private async projectTriggered(event: DomainEvent): Promise<void> {
    try {
      const payload = event.payload as { policyId?: string; triggerEventId?: string; payoutKobo?: number };
      if (!payload.policyId) {
        return;
      }
      const cover = (await this.covers.find({ policyId: payload.policyId }))[0];
      if (!cover || cover.status !== 'bound') {
        return;
      }
      const updated = await this.covers.updateExpected(
        cover.id,
        { status: 'triggered', updatedAt: new Date().toISOString() },
        { status: 'bound' }
      );
      await this.events.publish(
        'insurance.voucher_cover.triggered',
        {
          coverId: updated.id,
          voucherId: updated.voucherId,
          policyId: updated.policyId,
          programmeId: updated.programmeId,
          triggerEventId: payload.triggerEventId,
          payoutKobo: payload.payoutKobo
        },
        event.actorId
      );
    } catch (error) {
      // Projection failures must never break the insurance event fan-out;
      // the next evaluation replay re-delivers and re-projects.
      this.logger.warn(`voucher-cover trigger projection failed: ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * triggered → paid when the insurer payout is confirmed. The confirmation
   * itself is externally gated (insurer MOU; stub execution is 503 in
   * production) — this projector only mirrors the committed outcome.
   */
  private async projectPaid(event: DomainEvent): Promise<void> {
    try {
      const payload = event.payload as { policyId?: string; payoutId?: string; amountKobo?: number };
      if (!payload.policyId) {
        return;
      }
      const cover = (await this.covers.find({ policyId: payload.policyId }))[0];
      if (!cover || cover.status !== 'triggered') {
        return;
      }
      const updated = await this.covers.updateExpected(
        cover.id,
        { status: 'paid', updatedAt: new Date().toISOString() },
        { status: 'triggered' }
      );
      await this.events.publish(
        'insurance.voucher_cover.payout_posted',
        {
          coverId: updated.id,
          voucherId: updated.voucherId,
          policyId: updated.policyId,
          payoutId: payload.payoutId,
          amountKobo: payload.amountKobo
        },
        event.actorId
      );
      this.telemetry?.increment('insurance.voucher_covers_paid_total', 1, {
        programme_id: updated.programmeId
      });
    } catch (error) {
      this.logger.warn(`voucher-cover payout projection failed: ${(error as Error)?.message ?? error}`);
    }
  }
}
