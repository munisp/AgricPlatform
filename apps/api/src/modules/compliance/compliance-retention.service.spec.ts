import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationMessage, User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import type {
  ComplianceConsentRecord,
  DataSubjectRequest
} from '../../database/repositories/compliance.repository.js';
import {
  InMemoryComplianceConsentRepository,
  InMemoryDataSubjectRequestRepository,
  InMemoryRetentionPolicyRepository
} from '../../database/repositories/compliance.repository.js';
import { InMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { InMemoryInboundEventRepository, type InboundEvent } from '../../database/repositories/phase3.repository.js';
import { InMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { ComplianceRetentionService } from './compliance-retention.service.js';
import { pseudonymFor } from './compliance.service.js';

const admin: User = {
  id: 'user-ret-admin',
  phone: '+2348090000099',
  fullName: 'Retention Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const member: User = { ...admin, id: 'user-ret-member', roles: ['farmer'] };

const DAYS = 86_400_000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAYS).toISOString();

const oldRevokedConsent: ComplianceConsentRecord = {
  id: 'consent-ret-old',
  userId: 'user-ret-subject',
  purpose: 'marketing_sms',
  policyVersion: '2024-01',
  grantedAt: isoDaysAgo(900),
  revokedAt: isoDaysAgo(800),
  source: 'web'
};

const recentRevokedConsent: ComplianceConsentRecord = {
  id: 'consent-ret-recent',
  userId: 'user-ret-subject',
  purpose: 'marketing_email',
  policyVersion: '2026-01',
  grantedAt: isoDaysAgo(30),
  revokedAt: isoDaysAgo(10),
  source: 'web'
};

const activeConsent: ComplianceConsentRecord = {
  id: 'consent-ret-active',
  userId: 'user-ret-subject',
  purpose: 'data_sharing_partner',
  policyVersion: '2026-01',
  grantedAt: isoDaysAgo(900),
  source: 'agent'
};

const oldClosedDsr: DataSubjectRequest = {
  id: 'dsr-ret-old',
  userId: 'user-ret-subject',
  type: 'export',
  status: 'completed',
  requestedAt: isoDaysAgo(1200),
  completedAt: isoDaysAgo(1200),
  resultRef: 'sha256:abc'
};

const pendingDsr: DataSubjectRequest = {
  id: 'dsr-ret-pending',
  userId: 'user-ret-subject',
  type: 'erasure',
  status: 'pending',
  requestedAt: isoDaysAgo(1200)
};

const oldNotification: NotificationMessage = {
  id: 'notif-ret-old',
  userId: 'user-ret-subject',
  channel: 'sms',
  title: 'Old',
  body: 'Old notification',
  status: 'sent',
  createdAt: isoDaysAgo(400)
};

const recentNotification: NotificationMessage = {
  id: 'notif-ret-recent',
  userId: 'user-ret-subject',
  channel: 'sms',
  title: 'Recent',
  body: 'Recent notification',
  status: 'sent',
  createdAt: isoDaysAgo(5)
};

async function build(
  policySeed?: ConstructorParameters<typeof InMemoryRetentionPolicyRepository>[0],
  eventRows: {
    inbound?: readonly InboundEvent[];
    outbox?: ReadonlyArray<{ event: DomainEvent; publishedAt?: string; deadLetteredAt?: string }>;
    processed?: ReadonlyArray<{ consumer: string; eventId: string; processedAt: string }>;
  } = {},
  env: NodeJS.ProcessEnv = {}
) {
  const audit = new AuditService(createInMemoryAuditRepository());
  const policies = new InMemoryRetentionPolicyRepository(policySeed);
  const consents = new InMemoryComplianceConsentRepository([
    oldRevokedConsent,
    recentRevokedConsent,
    activeConsent
  ]);
  const dsr = new InMemoryDataSubjectRequestRepository([oldClosedDsr, pendingDsr]);
  const notifications = new InMemoryNotificationRepository([oldNotification, recentNotification]);
  const inboundEvents = new InMemoryInboundEventRepository(eventRows.inbound ?? []);
  const outbox = new InMemoryOutboxRepository();
  for (const row of eventRows.outbox ?? []) {
    // Deep-copy: anonymize/purge mutate payload in place; sharing the module-level
    // seed objects leaks tombstoned state across tests (order-dependent failures).
    await outbox.append(structuredClone(row.event));
    if (row.publishedAt) {
      await outbox.markPublished(row.event.id, row.publishedAt);
    }
    if (row.deadLetteredAt) {
      await outbox.markDeadLetter(row.event.id, row.deadLetteredAt);
    }
  }
  const processedEvents = new InMemoryProcessedEventRepository(eventRows.processed ?? []);
  const service = new ComplianceRetentionService(
    audit,
    policies,
    consents,
    dsr,
    notifications,
    inboundEvents,
    outbox,
    processedEvents,
    env
  );
  return { service, audit, policies, consents, dsr, notifications, inboundEvents, outbox, processedEvents };
}

describe('ComplianceRetentionService policies', () => {
  it('seeds the documented default policies', async () => {
    const { service } = await build();
    const policies = await service.listPolicies();
    expect(policies.map((p) => p.entity)).toEqual([
      'compliance.consent_records',
      'compliance.data_subject_requests',
      'events.outbox',
      'events.outbox_dead_letters',
      'events.processed_events',
      'integrations.inbound_events',
      'notifications.messages'
    ]);
    expect(policies.find((p) => p.entity === 'notifications.messages')?.anonymizeNotDelete).toBe(false);
    // V-27 defaults (migration 118): webhook payloads tombstoned, outbox pruned.
    expect(policies.find((p) => p.entity === 'integrations.inbound_events')).toMatchObject({
      retainDays: 90,
      anonymizeNotDelete: true
    });
    expect(policies.find((p) => p.entity === 'events.outbox')).toMatchObject({
      retainDays: 90,
      anonymizeNotDelete: false
    });
    // GAP-M20 default (migration 122): dead letters tombstoned then pruned.
    expect(policies.find((p) => p.entity === 'events.outbox_dead_letters')).toMatchObject({
      retainDays: 30,
      anonymizeNotDelete: false
    });
    // GAP-L11 default (migration 127): consumer-dedupe markers purged 90 days
    // after processing (aligned with events.outbox; no payload to anonymize).
    expect(policies.find((p) => p.entity === 'events.processed_events')).toMatchObject({
      retainDays: 90,
      anonymizeNotDelete: false
    });
  });

  it('upserts a policy (admin only)', async () => {
    const { service } = await build();
    await expect(
      service.upsertPolicy(member, { entity: 'notifications.messages', retainDays: 90, anonymizeNotDelete: true })
    ).rejects.toBeInstanceOf(ForbiddenException);
    const saved = await service.upsertPolicy(admin, {
      entity: 'notifications.messages',
      retainDays: 90,
      anonymizeNotDelete: true
    });
    expect(saved.retainDays).toBe(90);
    expect((await service.listPolicies()).find((p) => p.entity === 'notifications.messages')?.retainDays).toBe(90);
  });
});

describe('ComplianceRetentionService sweep', () => {
  it('requires an administrator', async () => {
    const { service } = await build();
    await expect(service.sweep(null)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.sweep(member)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dry-run (the default) counts expired rows without mutating them', async () => {
    const { service, consents, dsr, notifications } = await build();
    const result = await service.sweep(admin);
    expect(result.dryRun).toBe(true);
    const byEntity = Object.fromEntries(result.results.map((r) => [r.entity, r]));

    expect(byEntity['compliance.consent_records'].matched).toBe(1); // only the old revoked consent
    expect(byEntity['compliance.consent_records'].affected).toBe(0);
    expect(byEntity['compliance.data_subject_requests'].matched).toBe(1); // old closed DSR only
    expect(byEntity['notifications.messages'].matched).toBe(1);
    expect(result.totals.affected).toBe(0);

    // Nothing changed.
    expect((await consents.findById(oldRevokedConsent.id))?.userId).toBe('user-ret-subject');
    expect((await dsr.findById(oldClosedDsr.id))?.userId).toBe('user-ret-subject');
    expect(await notifications.findById(oldNotification.id)).toBeDefined();
  });

  it('execute anonymises consent/DSR rows and purges notifications per policy', async () => {
    const { service, consents, dsr, notifications } = await build();
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(result.totals.affected).toBe(3);

    // Consent row kept, personal reference tombstoned (proof of lawful basis survives).
    const anonymisedConsent = await consents.findById(oldRevokedConsent.id);
    expect(anonymisedConsent?.userId).toBe(pseudonymFor('user-ret-subject'));
    expect(anonymisedConsent?.revokedAt).toBe(oldRevokedConsent.revokedAt);
    // DSR row kept and tombstoned; pending DSR is NOT in scope.
    expect((await dsr.findById(oldClosedDsr.id))?.userId).toBe(pseudonymFor('user-ret-subject'));
    expect((await dsr.findById(pendingDsr.id))?.userId).toBe('user-ret-subject');
    // Notifications policy says delete: the old one is gone, the recent one stays.
    expect(await notifications.findById(oldNotification.id)).toBeUndefined();
    expect(await notifications.findById(recentNotification.id)).toBeDefined();
    // In-window and active consents untouched.
    expect((await consents.findById(recentRevokedConsent.id))?.userId).toBe('user-ret-subject');
    expect((await consents.findById(activeConsent.id))?.revokedAt).toBeUndefined();
  });

  it('anonymize_not_delete=false purges rows instead of tombstoning them', async () => {
    const { service, consents } = await build([
      {
        entity: 'compliance.consent_records',
        retainDays: 730,
        anonymizeNotDelete: false,
        updatedAt: isoDaysAgo(1)
      }
    ]);
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0].action).toBe('purge');
    expect(result.results[0].affected).toBe(1);
    expect(await consents.findById(oldRevokedConsent.id)).toBeUndefined();
    expect(await consents.findById(recentRevokedConsent.id)).toBeDefined();
  });

  it('reports unknown entities as skipped instead of failing', async () => {
    const { service } = await build([
      { entity: 'unknown.entity', retainDays: 30, anonymizeNotDelete: true, updatedAt: isoDaysAgo(1) }
    ]);
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].note).toContain('no retention handler');
    expect(result.totals.skipped).toBe(1);
  });

  it('a second execute changes nothing further (idempotent tombstones)', async () => {
    const { service, consents } = await build();
    const first = await service.sweep(admin, { dryRun: false });
    expect(first.totals.affected).toBe(3);
    const second = await service.sweep(admin, { dryRun: false });
    expect(second.totals.affected).toBe(0);
    // Tombstoned consent/DSR rows still match the time window (they are kept
    // by design) but anonymisation is a no-op on the second pass.
    expect(second.totals.matched).toBe(2);
    expect((await consents.findById(oldRevokedConsent.id))?.userId).toBe(
      pseudonymFor('user-ret-subject')
    );
  });
});

describe('ComplianceRetentionService V-27 webhook/outbox payload retention', () => {
  const oldProcessedInbound: InboundEvent = {
    id: 'inb-ret-old',
    system: 'lender',
    eventType: 'loan_event',
    dedupeKey: 'lender-evt-1',
    payload: { nin: '12345678901', amountNgn: 25000 },
    receivedAt: isoDaysAgo(120),
    processedAt: isoDaysAgo(100)
  };
  const recentProcessedInbound: InboundEvent = {
    id: 'inb-ret-recent',
    system: 'farmos',
    eventType: 'crop_plan',
    dedupeKey: 'farmos-evt-1',
    payload: { field: 'north-1' },
    receivedAt: isoDaysAgo(12),
    processedAt: isoDaysAgo(10)
  };
  // Old but NEVER processed: still eligible for re-drive, must be retained.
  const unprocessedInbound: InboundEvent = {
    id: 'inb-ret-unprocessed',
    system: 'lender',
    eventType: 'provider_webhook',
    dedupeKey: 'lender-evt-2',
    payload: { nin: '10987654321' },
    receivedAt: isoDaysAgo(400)
  };

  const outboxEvent = (id: string, payload: unknown): DomainEvent => ({
    id,
    name: 'partner.disbursement.recorded',
    payload,
    occurredAt: isoDaysAgo(120)
  });

  const inboundPolicy = { entity: 'integrations.inbound_events', retainDays: 90, anonymizeNotDelete: true, updatedAt: isoDaysAgo(1) };
  const outboxPolicy = { entity: 'events.outbox', retainDays: 90, anonymizeNotDelete: false, updatedAt: isoDaysAgo(1) };

  it('dry-run counts processed-old inbound rows without touching payloads', async () => {
    const { service, inboundEvents } = await build([inboundPolicy], {
      inbound: [oldProcessedInbound, recentProcessedInbound, unprocessedInbound]
    });
    const result = await service.sweep(admin); // dry-run is the default
    expect(result.results[0]).toMatchObject({
      entity: 'integrations.inbound_events',
      matched: 1, // only the old processed row
      action: 'anonymize',
      affected: 0
    });
    expect((await inboundEvents.findById(oldProcessedInbound.id))?.payload).toEqual({
      nin: '12345678901',
      amountNgn: 25000
    });
  });

  it('execute tombstones old inbound payloads, keeps metadata and recent/unprocessed rows', async () => {
    const { service, audit, inboundEvents } = await build([inboundPolicy], {
      inbound: [oldProcessedInbound, recentProcessedInbound, unprocessedInbound]
    });
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 1, action: 'anonymize', affected: 1 });

    // Row metadata survives as the processing audit trail; PII payload is gone.
    const scrubbed = await inboundEvents.findById(oldProcessedInbound.id);
    expect(scrubbed?.payload).toEqual({});
    expect(scrubbed?.dedupeKey).toBe('lender-evt-1');
    expect(scrubbed?.processedAt).toBe(oldProcessedInbound.processedAt);
    // In-window and unprocessed rows are untouched.
    expect((await inboundEvents.findById(recentProcessedInbound.id))?.payload).toEqual({ field: 'north-1' });
    expect((await inboundEvents.findById(unprocessedInbound.id))?.payload).toEqual({ nin: '10987654321' });

    // Idempotent: a second sweep changes nothing further.
    const second = await service.sweep(admin, { dryRun: false });
    expect(second.results[0].affected).toBe(0);

    // The sweep itself is audited.
    const auditEvents = await audit.list({ entityType: 'retention_sweep' });
    expect(auditEvents.map((event) => event.action)).toContain('compliance.retention_sweep_executed');
  });

  it('anonymize_not_delete=false hard-deletes old processed inbound rows', async () => {
    const { service, inboundEvents } = await build(
      [{ ...inboundPolicy, anonymizeNotDelete: false }],
      { inbound: [oldProcessedInbound, recentProcessedInbound, unprocessedInbound] }
    );
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 1, action: 'purge', affected: 1 });
    expect(await inboundEvents.findById(oldProcessedInbound.id)).toBeUndefined();
    expect(await inboundEvents.findById(recentProcessedInbound.id)).toBeDefined();
    expect(await inboundEvents.findById(unprocessedInbound.id)).toBeDefined();
  });

  it('events.outbox prunes published-old rows, retains recent and unpublished', async () => {
    const { service, outbox } = await build([outboxPolicy], {
      outbox: [
        { event: outboxEvent('evt-ret-old', { partnerId: 'p1', userId: 'u1' }), publishedAt: isoDaysAgo(100) },
        { event: outboxEvent('evt-ret-recent', { partnerId: 'p1' }), publishedAt: isoDaysAgo(10) },
        { event: outboxEvent('evt-ret-pending', { partnerId: 'p1' }) } // never published
      ]
    });
    const dry = await service.sweep(admin);
    expect(dry.results[0]).toMatchObject({ entity: 'events.outbox', matched: 1, action: 'purge', affected: 0 });
    expect((await outbox.listRecords()).map((record) => record.event.id)).toHaveLength(3);

    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 1, affected: 1 });
    const remaining = (await outbox.listRecords()).map((record) => record.event.id);
    expect(remaining).not.toContain('evt-ret-old');
    expect(remaining).toContain('evt-ret-recent');
    expect(remaining).toContain('evt-ret-pending'); // unpublished rows are never in scope
  });

  it('events.outbox anonymize_not_delete=true tombstones payloads instead of deleting', async () => {
    const { service, outbox } = await build(
      [{ ...outboxPolicy, anonymizeNotDelete: true }],
      { outbox: [{ event: outboxEvent('evt-ret-old', { partnerId: 'p1', userId: 'u1' }), publishedAt: isoDaysAgo(100) }] }
    );
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 1, action: 'anonymize', affected: 1 });
    const [record] = await outbox.listRecords();
    expect(record.event.id).toBe('evt-ret-old'); // metadata survives
    expect(record.event.payload).toEqual({});
    expect(record.publishedAt).toBeDefined();
  });

  // GAP-M20: dead-lettered outbox rows carry full payloads forever
  // (published_at stays NULL, so the events.outbox handler never matches
  // them). Their own handler sweeps on dead_lettered_at and ALWAYS
  // anonymizes the payload before purging.
  const deadLetterPolicy = {
    entity: 'events.outbox_dead_letters',
    retainDays: 30,
    anonymizeNotDelete: false,
    updatedAt: isoDaysAgo(1)
  };
  const deadRows = [
    { event: outboxEvent('evt-dl-old', { partnerId: 'p1', userId: 'u1' }), deadLetteredAt: isoDaysAgo(45) },
    { event: outboxEvent('evt-dl-recent', { partnerId: 'p1' }), deadLetteredAt: isoDaysAgo(5) },
    { event: outboxEvent('evt-dl-published', { partnerId: 'p1', userId: 'u2' }), publishedAt: isoDaysAgo(45) },
    { event: outboxEvent('evt-dl-pending', { partnerId: 'p1' }) } // never terminal
  ];

  it('GAP-M20 dry-run counts old dead letters without touching payloads', async () => {
    const { service, outbox } = await build([deadLetterPolicy], { outbox: deadRows });
    const result = await service.sweep(admin); // dry-run is the default
    expect(result.results[0]).toMatchObject({
      entity: 'events.outbox_dead_letters',
      matched: 1,
      action: 'purge',
      affected: 0
    });
    const records = await outbox.listRecords();
    expect(records).toHaveLength(4);
    expect(records.find((record) => record.event.id === 'evt-dl-old')?.event.payload).toEqual({
      partnerId: 'p1',
      userId: 'u1'
    });
  });

  it('GAP-M20 execute anonymizes the payload then purges old dead letters', async () => {
    const { service, outbox } = await build([deadLetterPolicy], { outbox: deadRows });
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 1, action: 'purge', affected: 1 });
    expect(result.results[0].note).toContain('anonymized');
    const remaining = (await outbox.listRecords()).map((record) => record.event.id);
    expect(remaining).not.toContain('evt-dl-old');
    // In-window dead letter, published row, and non-terminal row are retained.
    expect(remaining).toEqual(expect.arrayContaining(['evt-dl-recent', 'evt-dl-published', 'evt-dl-pending']));
  });

  it('GAP-M20 anonymize_not_delete=true tombstones the payload, keeps the dead letter for forensics', async () => {
    const { service, outbox } = await build(
      [{ ...deadLetterPolicy, anonymizeNotDelete: true }],
      { outbox: deadRows }
    );
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 1, action: 'anonymize', affected: 1 });
    const record = (await outbox.listRecords()).find((row) => row.event.id === 'evt-dl-old');
    expect(record).toBeDefined();
    expect(record?.event.payload).toEqual({});
    expect(record?.deadLetteredAt).toBeDefined();
    // Idempotent: a second sweep changes nothing further.
    const second = await service.sweep(admin, { dryRun: false });
    expect(second.results[0].affected).toBe(0);
  });

  it('GAP-M20 never matches unpublished or published rows (only dead_lettered_at)', async () => {
    const { service, outbox } = await build([deadLetterPolicy], {
      outbox: [
        { event: outboxEvent('evt-dl-published-old', { userId: 'u1' }), publishedAt: isoDaysAgo(400) },
        { event: outboxEvent('evt-dl-pending-old', { userId: 'u1' }) }
      ]
    });
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 0, affected: 0 });
    expect(await outbox.listRecords()).toHaveLength(2);
  });
});

describe('ComplianceRetentionService GAP-L11 events.processed_events retention', () => {
  const processedPolicy = {
    entity: 'events.processed_events',
    retainDays: 90,
    anonymizeNotDelete: false,
    updatedAt: isoDaysAgo(1)
  };
  const processedRows = [
    { consumer: 'analytics-projector', eventId: 'evt-pe-old-1', processedAt: isoDaysAgo(120) },
    { consumer: 'analytics-projector', eventId: 'evt-pe-old-2', processedAt: isoDaysAgo(100) },
    { consumer: 'fraud-sentinel', eventId: 'evt-pe-recent', processedAt: isoDaysAgo(10) }
  ];

  it('dry-run (the default) counts old dedupe markers without deleting them', async () => {
    const { service, processedEvents } = await build([processedPolicy], { processed: processedRows });
    const result = await service.sweep(admin);
    expect(result.results[0]).toMatchObject({
      entity: 'events.processed_events',
      retainDays: 90,
      matched: 2, // only the two markers past the 90-day window
      action: 'purge',
      affected: 0
    });
    expect(await processedEvents.has('analytics-projector', 'evt-pe-old-1')).toBe(true);
    expect(await processedEvents.has('analytics-projector', 'evt-pe-old-2')).toBe(true);
    expect(await processedEvents.has('fraud-sentinel', 'evt-pe-recent')).toBe(true);
  });

  it('execute purges markers older than the window and keeps newer ones', async () => {
    const { service, audit, processedEvents } = await build([processedPolicy], { processed: processedRows });
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 2, action: 'purge', affected: 2 });
    expect(await processedEvents.has('analytics-projector', 'evt-pe-old-1')).toBe(false);
    expect(await processedEvents.has('analytics-projector', 'evt-pe-old-2')).toBe(false);
    expect(await processedEvents.has('fraud-sentinel', 'evt-pe-recent')).toBe(true);

    // Idempotent: a second sweep deletes nothing further.
    const second = await service.sweep(admin, { dryRun: false });
    expect(second.results[0].affected).toBe(0);

    // The sweep itself is audited.
    const auditEvents = await audit.list({ entityType: 'retention_sweep' });
    expect(auditEvents.map((event) => event.action)).toContain('compliance.retention_sweep_executed');
  });

  it('honours PROCESSED_EVENTS_PURGE_BATCH_SIZE (drains oldest-first in capped batches)', async () => {
    const rows = [1, 2, 3].map((i) => ({
      consumer: 'analytics-projector',
      eventId: `evt-pe-batch-${i}`,
      processedAt: isoDaysAgo(100 + i)
    }));
    const { service, processedEvents } = await build(
      [processedPolicy],
      { processed: rows },
      { PROCESSED_EVENTS_PURGE_BATCH_SIZE: '2' }
    );
    const purgeSpy = vi.spyOn(processedEvents, 'purgeProcessedBefore');
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 3, affected: 3 });
    // 3 expired rows with a batch cap of 2: batches of 2 then 1 (short batch ends the loop).
    expect(purgeSpy).toHaveBeenCalledTimes(2);
    expect(purgeSpy.mock.calls.every((call) => call[1] === 2)).toBe(true);
    for (const row of rows) {
      expect(await processedEvents.has(row.consumer, row.eventId)).toBe(false);
    }
  });

  it('PROCESSED_EVENTS_RETENTION_DAYS overrides the policy window', async () => {
    const { service } = await build(
      [processedPolicy],
      {
        processed: [
          { consumer: 'analytics-projector', eventId: 'evt-pe-old', processedAt: isoDaysAgo(30) },
          { consumer: 'analytics-projector', eventId: 'evt-pe-new', processedAt: isoDaysAgo(5) }
        ]
      },
      { PROCESSED_EVENTS_RETENTION_DAYS: '10' }
    );
    const result = await service.sweep(admin, { dryRun: false });
    // 10-day env window (not the 90-day policy): only the 30-day-old marker goes.
    expect(result.results[0]).toMatchObject({ retainDays: 10, matched: 1, affected: 1 });
  });

  it('a failing purge is logged and surfaced without rejecting the sweep (fail-closed)', async () => {
    const { service, audit, processedEvents } = await build([processedPolicy], { processed: processedRows });
    vi.spyOn(processedEvents, 'purgeProcessedBefore').mockRejectedValueOnce(new Error('db down'));
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({
      entity: 'events.processed_events',
      matched: 2,
      action: 'purge',
      affected: 0
    });
    expect(result.results[0].note).toContain('purge failed: db down');
    // Nothing was deleted and the sweep completed (audit trail still written).
    expect(await processedEvents.has('analytics-projector', 'evt-pe-old-1')).toBe(true);
    const auditEvents = await audit.list({ entityType: 'retention_sweep' });
    expect(auditEvents.map((event) => event.action)).toContain('compliance.retention_sweep_executed');
  });

  it('anonymize_not_delete=true still purges (dedupe markers carry no payload to tombstone)', async () => {
    const { service, processedEvents } = await build(
      [{ ...processedPolicy, anonymizeNotDelete: true }],
      { processed: processedRows }
    );
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0]).toMatchObject({ matched: 2, action: 'purge', affected: 2 });
    expect(result.results[0].note).toContain('purge-only');
    expect(await processedEvents.has('fraud-sentinel', 'evt-pe-recent')).toBe(true);
  });
});
