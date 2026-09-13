/**
 * Lender Lens service tests (Stage 27, innovation #20): flag gating,
 * generate-on-first-serve immutability, projector-heartbeat stale badge,
 * benchmark recomputation, and outbox event emission — over in-memory
 * repositories with the real DomainEventsService outbox.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, beforeEach } from 'vitest';
import type { CreditLoanApplication, CreditRepayment, Profile, User } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAnalyticsStarRepository } from '../../database/repositories/analytics-star.repository.js';
import {
  InMemoryCreditLoanRepository,
  InMemoryCreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryLenderScorecardRepository } from '../../database/repositories/lender-scorecard.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { DEFAULT_SCORECARD_DEFINITION } from './lender-scorecard.js';
import { LENDER_LENS_FLAG, LenderScorecardService } from './lender-scorecard.service.js';
import { ANALYTICS_PROJECTOR_CONSUMER } from './projector.service.js';

const PERIOD = '2026-08';
const ADMIN: User = {
  id: 'admin-1',
  phone: '08000000000',
  fullName: 'Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_3',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

function loan(partial: Partial<CreditLoanApplication> & { id: string }): CreditLoanApplication {
  return {
    applicantUserId: 'borrower-1',
    productId: 'prod-cash',
    principalKobo: 100_000,
    status: 'repaying',
    createdAt: '2026-05-10T08:00:00.000Z',
    updatedAt: '2026-05-10T08:00:00.000Z',
    ...partial
  };
}

function installment(partial: Partial<CreditRepayment> & { id: string; loanId: string }): CreditRepayment {
  return {
    sequence: 1,
    dueAt: '2026-07-15T00:00:00.000Z',
    amountKobo: 100_000,
    status: 'pending',
    ...partial
  };
}

function profile(userId: string, state: string): Profile {
  return {
    userId,
    location: { state, lga: 'test-lga' },
    farmingInterests: [],
    valueChains: [],
    completionScore: 0,
    badges: []
  };
}

interface Harness {
  service: LenderScorecardService;
  events: DomainEventsService;
  flags: FeatureFlagsService;
  outbox: ReturnType<typeof createInMemoryOutboxRepository>;
}

function harness(options: { flagEnabled: boolean }): Harness {
  const flagRepo = createInMemoryFeatureFlagRepository([
    {
      key: LENDER_LENS_FLAG,
      enabled: options.flagEnabled,
      roleAllowlist: [],
      percentage: 100,
      description: 'test'
    }
  ]);
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const loans = new InMemoryCreditLoanRepository([
    loan({ id: 'loan-1', applicantUserId: 'borrower-1', productId: 'prod-cash' }),
    loan({ id: 'loan-2', applicantUserId: 'borrower-2', productId: 'prod-inputs' }),
    loan({ id: 'loan-3', applicantUserId: 'stranger-1', productId: 'prod-cash' })
  ]);
  const repayments = new InMemoryCreditRepaymentRepository([
    installment({ id: 'r-1', loanId: 'loan-1' }),
    installment({ id: 'r-2', loanId: 'loan-2' }),
    installment({ id: 'r-3', loanId: 'loan-3' })
  ]);
  const profiles = new InMemoryProfileRepository([
    profile('borrower-1', 'Kaduna'),
    profile('borrower-2', 'Kano'),
    profile('stranger-1', 'Lagos')
  ]);
  const star = createInMemoryAnalyticsStarRepository();
  const service = new LenderScorecardService(
    createInMemoryLenderScorecardRepository(),
    loans,
    repayments,
    profiles,
    outbox,
    star,
    events,
    new FeatureFlagsService(flagRepo),
    new TelemetryService()
  );
  return { service, events, flags: new FeatureFlagsService(flagRepo), outbox };
}

async function attribute(h: Harness, partnerId: string, userId: string): Promise<void> {
  await h.events.publish('partner.disbursement.recorded', { partnerId, userId }, 'test');
}

describe('LenderScorecardService', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness({ flagEnabled: true });
    await h.service.publishVersion(ADMIN, { version: '1.0.0', definition: {} });
  });

  it('fails closed when the lender-lens flag is off (404)', async () => {
    const off = harness({ flagEnabled: false });
    await expect(off.service.scorecard('lender-a', PERIOD)).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      off.service.publishVersion(ADMIN, { version: '1.0.0', definition: {} })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('generates only over attributed borrowers (outbox-fed)', async () => {
    await attribute(h, 'lender-a', 'borrower-1');
    const envelope = await h.service.scorecard('lender-a', PERIOD);
    expect(envelope.created).toBe(true);
    expect(envelope.payload.portfolio.activeLoans).toBe(1);
    expect(envelope.payload.portfolio.par30Bps).toBe(10_000);
    expect(envelope.payload.geoMix).toEqual([
      { band: 'Kaduna', outstandingKobo: 100_000, shareBps: 10_000 }
    ]);
    expect(envelope.payload.lenderPartnerId).toBe('lender-a');
  });

  it('serves the immutable stored payload on repeat reads', async () => {
    await attribute(h, 'lender-a', 'borrower-1');
    const first = await h.service.scorecard('lender-a', PERIOD);
    // New attribution after generation must NOT rewrite the stored payload.
    await attribute(h, 'lender-a', 'borrower-2');
    const second = await h.service.scorecard('lender-a', PERIOD);
    expect(second.created).toBe(false);
    expect(second.payloadHash).toBe(first.payloadHash);
    expect(second.payload.portfolio.activeLoans).toBe(1);
  });

  it('emits analytics.lender_scorecard.generated once per immutable scorecard', async () => {
    await attribute(h, 'lender-a', 'borrower-1');
    const first = await h.service.scorecard('lender-a', PERIOD);
    await h.service.scorecard('lender-a', PERIOD);
    await h.service.scorecard('lender-a', PERIOD);
    const records = await h.outbox.listRecords();
    const generated = records.filter(
      (record) => record.event.name === 'analytics.lender_scorecard.generated'
    );
    expect(generated).toHaveLength(1);
    const payload = generated[0]!.event.payload as Record<string, unknown>;
    expect(payload.tenantId).toBe('lender-a');
    expect(payload.payloadHash).toBe(first.payloadHash);
    const published = records.filter(
      (record) => record.event.name === 'analytics.scorecard_version.published'
    );
    expect(published).toHaveLength(1);
  });

  it('rejects divergent regeneration per (lender, version, period) with 409', async () => {
    await attribute(h, 'lender-a', 'borrower-1');
    const envelope = await h.service.scorecard('lender-a', PERIOD);
    const repo = createInMemoryLenderScorecardRepository();
    await repo.insertScorecard({
      id: 'lsc-x',
      lenderPartnerId: 'lender-a',
      version: '1.0.0',
      period: PERIOD,
      payload: envelope.payload,
      payloadHash: envelope.payloadHash,
      generatedAt: envelope.generatedAt
    });
    // Identical replay: idempotent.
    const replay = await repo.insertScorecard({
      id: 'lsc-y',
      lenderPartnerId: 'lender-a',
      version: '1.0.0',
      period: PERIOD,
      payload: envelope.payload,
      payloadHash: envelope.payloadHash,
      generatedAt: new Date().toISOString()
    });
    expect(replay.created).toBe(false);
    // Divergent payload under the same key: conflict, never overwrite.
    await expect(
      repo.insertScorecard({
        id: 'lsc-z',
        lenderPartnerId: 'lender-a',
        version: '1.0.0',
        period: PERIOD,
        payload: { ...envelope.payload, lenderPartnerId: 'lender-b' },
        payloadHash: 'f'.repeat(64),
        generatedAt: new Date().toISOString()
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects re-publishing a version with a different definition', async () => {
    await expect(
      h.service.publishVersion(ADMIN, { version: '1.0.0', definition: { geoMixFloorBps: 0 } })
    ).rejects.toBeInstanceOf(ConflictException);
    const replay = await h.service.publishVersion(ADMIN, { version: '1.0.0', definition: {} });
    expect(replay.created).toBe(false);
  });

  it('carries the stale badge when the projector heartbeat is missing', async () => {
    await attribute(h, 'lender-a', 'borrower-1');
    const envelope = await h.service.scorecard('lender-a', PERIOD);
    expect(envelope.stale).toBe(true);
    expect(envelope.projectorLagMs).toBeNull();
  });

  it('clears the stale badge with a fresh projector heartbeat', async () => {
    const fresh = createInMemoryAnalyticsStarRepository();
    await fresh.recordProjection(ANALYTICS_PROJECTOR_CONSUMER, {
      lastRunAt: new Date().toISOString(),
      processedDelta: 1
    });
    const flagRepo = createInMemoryFeatureFlagRepository([
      { key: LENDER_LENS_FLAG, enabled: true, roleAllowlist: [], percentage: 100, description: 't' }
    ]);
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    const service = new LenderScorecardService(
      createInMemoryLenderScorecardRepository(),
      new InMemoryCreditLoanRepository([loan({ id: 'loan-1' })]),
      new InMemoryCreditRepaymentRepository([installment({ id: 'r-1', loanId: 'loan-1' })]),
      new InMemoryProfileRepository([profile('borrower-1', 'Kaduna')]),
      outbox,
      fresh,
      events,
      new FeatureFlagsService(flagRepo),
      new TelemetryService()
    );
    await service.publishVersion(ADMIN, { version: '1.0.0', definition: {} });
    await events.publish('partner.disbursement.recorded', { partnerId: 'lender-a', userId: 'borrower-1' }, 't');
    const envelope = await service.scorecard('lender-a', PERIOD);
    expect(envelope.stale).toBe(false);
    expect(envelope.projectorLagMs).not.toBeNull();
    expect(envelope.projectorLagMs as number).toBeLessThan(
      DEFAULT_SCORECARD_DEFINITION.staleThresholdMs
    );
  });

  it('recomputes suppressed benchmark cells until the k-anonymity floor is met', async () => {
    for (let index = 0; index < 5; index += 1) {
      await attribute(h, `lender-${index}`, 'borrower-1');
    }
    for (let index = 0; index < 4; index += 1) {
      await h.service.scorecard(`lender-${index}`, PERIOD);
    }
    let cells = await h.service.benchmarks('1.0.0', PERIOD, { roles: ['admin'] });
    expect(cells.every((cell) => cell.suppressed)).toBe(true);
    await h.service.scorecard('lender-4', PERIOD);
    cells = await h.service.benchmarks('1.0.0', PERIOD, { roles: ['admin'] });
    expect(cells.every((cell) => !cell.suppressed)).toBe(true);
    expect(cells.find((cell) => cell.metric === 'par30_bps')?.lenderCount).toBe(5);
  });
});
