import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import { newId } from '../../../common/async-repository.js';
import {
  CONSENT_REPOSITORY,
  INBOUND_EVENT_REPOSITORY
} from '../../../database/persistence.tokens.js';
import type { ConsentRepository } from '../../../database/repositories/consent.repository.js';
import type { InboundEventRepository } from '../../../database/repositories/phase3.repository.js';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import { CreditService } from '../../finance/credit.service.js';
import { createLenderClient, lenderDriverEnabled, type LenderClient } from '../drivers/lender.client.js';
import { payloadDedupeKey, sha256 } from './phase3.utils.js';

/** Consent purpose that authorises the lender credit-readiness push. */
export const LENDER_CONSENT_PURPOSE = 'lender_data_sharing';

export interface CreditReadinessResult {
  pushed: boolean;
  score: number;
  memberRef: string;
}

/**
 * Input-finance bridge (wave P5a). Outbound: pushes an anonymised,
 * consent-gated credit-readiness snapshot (salted member ref hash + score,
 * never name/phone/NIN/BVN) to the lender endpoint — no consent, no push.
 * Inbound: loan status/repayment events are ledgered replay-safe and
 * republished into the finance domain. Inert while LENDER_DRIVER is stub.
 */
@Injectable()
export class LenderIntegrationService {
  constructor(
    private readonly credit: CreditService,
    @Inject(CONSENT_REPOSITORY) private readonly consents: ConsentRepository,
    @Inject(INBOUND_EVENT_REPOSITORY) private readonly inbound: InboundEventRepository,
    private readonly events: DomainEventsService,
    @Optional() private readonly client: LenderClient | undefined = createLenderClient(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get enabled(): boolean {
    return lenderDriverEnabled(this.env) && this.client !== undefined;
  }

  /** Active lender_data_sharing consent record, or undefined. */
  private async activeConsent(userId: string) {
    return (await this.consents.find({ userId })).find(
      (consent) =>
        consent.purpose === LENDER_CONSENT_PURPOSE && consent.granted && !consent.revokedAt
    );
  }

  /**
   * Consent-gated push. Throws ForbiddenException without an active
   * lender_data_sharing consent (test: the no-consent denial) and
   * BadRequestException while the driver is stub.
   */
  async pushCreditReadiness(userId: string): Promise<CreditReadinessResult> {
    const consent = await this.activeConsent(userId);
    if (!consent) {
      throw new ForbiddenException(
        `Active '${LENDER_CONSENT_PURPOSE}' consent is required before sharing credit readiness with lenders`
      );
    }
    if (!this.client) {
      throw new BadRequestException('Lender bridge is disabled (LENDER_DRIVER is stub or unkeyed)');
    }
    const score = await this.credit.scoreForUser(userId);
    const memberRef = sha256(`lender:${userId}`);
    await this.client.pushCreditReadiness({
      memberRef,
      score: score.score,
      version: score.version,
      consentPurpose: LENDER_CONSENT_PURPOSE,
      consentedAt: consent.grantedAt,
      computedAt: score.computedAt
    });
    await this.events.publish('finance.lender_credit_readiness.pushed', {
      memberRef,
      score: score.score
    }, userId);
    return { pushed: true, score: score.score, memberRef };
  }

  /**
   * Inbound loan status / repayment event: ledgered (replay-safe) and
   * republished as a finance domain event. Returns whether it was new.
   */
  async handleLoanEvent(
    payload: Record<string, unknown>,
    eventId?: string
  ): Promise<{ received: boolean }> {
    const dedupeKey = eventId ?? String(payload['event_id'] ?? payload['reference'] ?? payloadDedupeKey(payload));
    const event = await this.inbound.ingest({
      id: newId('evt'),
      system: 'lender',
      eventType: String(payload['event'] ?? payload['type'] ?? 'loan.status_changed'),
      dedupeKey,
      payload,
      receivedAt: new Date().toISOString()
    });
    if (!event) {
      return { received: false };
    }
    await this.events.publish('finance.lender_event.received', {
      eventType: event.eventType,
      memberRef: payload['member_ref'] !== undefined ? String(payload['member_ref']) : undefined,
      loanReference: payload['reference'] !== undefined ? String(payload['reference']) : undefined,
      status: payload['status'] !== undefined ? String(payload['status']) : undefined,
      amountNaira: typeof payload['amount'] === 'number' ? payload['amount'] : undefined
    });
    await this.inbound.markProcessed(event.id, new Date().toISOString());
    return { received: true };
  }
}
