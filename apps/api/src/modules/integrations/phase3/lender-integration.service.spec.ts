import { describe, expect, it } from 'vitest';
import type { ConsentRecord } from '@agric-platform/shared';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import { InMemoryConsentRepository } from '../../../database/repositories/consent.repository.js';
import { createInMemoryOutboxRepository } from '../../../database/repositories/outbox.repository.js';
import { createInMemoryInboundEventRepository } from '../../../database/repositories/phase3.repository.js';
import type { CreditService } from '../../finance/credit.service.js';
import type { CreditReadinessPush, LenderClient } from '../drivers/lender.client.js';
import {
  LENDER_CONSENT_PURPOSE,
  LenderIntegrationService
} from './lender-integration.service.js';
import { sha256 } from './phase3.utils.js';

const consent = (overrides: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: 'consent-1',
  userId: 'user-1',
  purpose: LENDER_CONSENT_PURPOSE,
  granted: true,
  source: 'profile_settings',
  grantedAt: '2026-01-10T00:00:00.000Z',
  ...overrides
});

class FakeLenderClient {
  readonly pushes: CreditReadinessPush[] = [];
  async pushCreditReadiness(payload: CreditReadinessPush): Promise<void> {
    this.pushes.push(payload);
  }
}

const fakeCredit = {
  scoreForUser: async (userId: string) => ({
    userId,
    version: 'credit-score/v1',
    score: 642,
    components: { training: 200 },
    computedAt: '2026-05-01T00:00:00.000Z'
  })
} as unknown as CreditService;

function setup(consents: ConsentRecord[], env: NodeJS.ProcessEnv = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const inbound = createInMemoryInboundEventRepository();
  const client = new FakeLenderClient();
  const service = new LenderIntegrationService(
    fakeCredit,
    new InMemoryConsentRepository(consents),
    inbound,
    events,
    client as unknown as LenderClient,
    env
  );
  return { events, inbound, client, service };
}

describe('LenderIntegrationService credit-readiness push', () => {
  it('pushes an anonymised consented snapshot (no name/phone/NIN)', async () => {
    const { service, client } = setup([consent()], { LENDER_DRIVER: 'live' });
    const result = await service.pushCreditReadiness('user-1');
    expect(result).toMatchObject({ pushed: true, score: 642, memberRef: sha256('lender:user-1') });
    expect(client.pushes).toHaveLength(1);
    const payload = client.pushes[0];
    expect(payload).toMatchObject({
      memberRef: sha256('lender:user-1'),
      score: 642,
      consentPurpose: LENDER_CONSENT_PURPOSE,
      consentedAt: '2026-01-10T00:00:00.000Z'
    });
    expect(JSON.stringify(payload)).not.toContain('user-1');
  });

  it('denies the push without consent (no-consent denial)', async () => {
    const { service, client } = setup([]);
    await expect(service.pushCreditReadiness('user-1')).rejects.toThrow(/consent is required/);
    expect(client.pushes).toHaveLength(0);
  });

  it('denies the push when consent was revoked or for another purpose', async () => {
    const revoked = setup([consent({ revokedAt: '2026-02-01T00:00:00.000Z' })]);
    await expect(revoked.service.pushCreditReadiness('user-1')).rejects.toThrow(/consent is required/);
    const otherPurpose = setup([consent({ purpose: 'sms_notifications' })]);
    await expect(otherPurpose.service.pushCreditReadiness('user-1')).rejects.toThrow(/consent is required/);
  });

  it('fails closed while the driver is stub', async () => {
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const service = new LenderIntegrationService(
      fakeCredit,
      new InMemoryConsentRepository([consent()]),
      createInMemoryInboundEventRepository(),
      events,
      undefined,
      { LENDER_DRIVER: 'stub' }
    );
    expect(service.enabled).toBe(false);
    await expect(service.pushCreditReadiness('user-1')).rejects.toThrow(/LENDER_DRIVER is stub/);
  });
});

describe('LenderIntegrationService inbound loan events', () => {
  it('ledgers events replay-safe and republishes to the finance domain', async () => {
    const { service, events, inbound } = setup([]);
    const published: Array<{ name: string; payload: unknown }> = [];
    const original = events.publish.bind(events);
    events.publish = async <T,>(name: string, payload: T, actorId?: string) => {
      published.push({ name, payload });
      return original(name, payload, actorId);
    };
    const result = await service.handleLoanEvent(
      { event: 'repayment.received', member_ref: 'ref-1', reference: 'loan-7', amount: 50000, status: 'repaid' },
      'evt-9'
    );
    expect(result.received).toBe(true);
    expect(published[0]).toMatchObject({ name: 'finance.lender_event.received' });
    expect(published[0].payload).toMatchObject({
      eventType: 'repayment.received',
      loanReference: 'loan-7',
      amountNaira: 50000
    });
    const replay = await service.handleLoanEvent({ event: 'repayment.received' }, 'evt-9');
    expect(replay.received).toBe(false);
    expect(await inbound.all()).toHaveLength(1);
    expect((await inbound.all())[0].processedAt).toBeTruthy();
  });
});
