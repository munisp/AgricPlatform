import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@agric-platform/shared';
import {
  createInMemoryAuditAnchorRepository,
  InMemoryAuditAnchorRepository
} from '../database/repositories/audit-anchor.repository.js';
import { InMemoryAuditRepository } from '../database/repositories/audit.repository.js';
import { GENESIS_HASH, hashAuditAnchor } from './audit-chain.js';
import {
  AnchorSinkConfigError,
  createAnchorSink,
  FailingAnchorSink,
  FileAnchorSink
} from './audit-anchor-sink.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { AuditService } from './audit.service.js';

/**
 * Stage 23 anchoring checkpoint tests (in-memory). The pg contract coverage
 * lives in test/pg/audit-chain.pg.spec.ts next to the event-chain fork-guard
 * tests so both suites share one sequential database story.
 */

/** Test subclass that simulates an attacker deleting the chain tail. */
class TruncatableAuditRepository extends InMemoryAuditRepository {
  truncate(keep: number): void {
    (this as unknown as { events: AuditEvent[] }).events.length = keep;
  }
}

function build(env: NodeJS.ProcessEnv = {}) {
  const events = new TruncatableAuditRepository();
  const anchors = createInMemoryAuditAnchorRepository();
  const audit = new AuditService(events);
  const service = new AuditAnchorService(events, anchors, env, null);
  return { events, anchors, audit, service };
}

const input = (action: string, entityId: string) => ({
  actorId: 'admin-1',
  action,
  entityType: 'user',
  entityId
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AuditAnchorService anchor creation', () => {
  it('anchors the current chain tip, linked to the anchor genesis hash', async () => {
    const { audit, service } = build();
    await audit.record(input('user.suspend', 'user-1'));
    const tip = await audit.record(input('user.activate', 'user-1'));

    const anchor = await service.createAnchor();

    expect(anchor.anchoredThroughEventId).toBe(tip.id);
    expect(anchor.tipHash).toBe(tip.hash);
    expect(anchor.eventCount).toBe(2);
    expect(anchor.prevAnchorHash).toBe(GENESIS_HASH);
    expect(anchor.anchorHash).toMatch(/^[0-9a-f]{64}$/);
    // The hash covers the whole payload (minus anchorHash) + prevAnchorHash,
    // recomputed with the same canonicalJSON the event chain uses.
    const { anchorHash, ...unsigned } = anchor;
    expect(anchorHash).toBe(hashAuditAnchor(unsigned, GENESIS_HASH));
  });

  it('anchors over an empty chain (genesis anchor)', async () => {
    const { service } = build();
    const anchor = await service.createAnchor();
    expect(anchor.anchoredThroughEventId).toBeNull();
    expect(anchor.tipHash).toBe(GENESIS_HASH);
    expect(anchor.eventCount).toBe(0);
    await expect(service.verifyAnchors()).resolves.toEqual({ valid: true, checked: 1 });
  });

  it('chains consecutive anchors to each other', async () => {
    const { audit, service } = build();
    await audit.record(input('a', 'e-1'));
    const first = await service.createAnchor();
    await audit.record(input('b', 'e-2'));
    const second = await service.createAnchor();

    expect(second.prevAnchorHash).toBe(first.anchorHash);
    expect(second.eventCount).toBe(2);
    expect(second.createdAt > first.createdAt).toBe(true);
    await expect(service.verifyAnchors()).resolves.toEqual({ valid: true, checked: 2 });
  });

  it('never touches the anchor store from the audit append path', async () => {
    const events = new TruncatableAuditRepository();
    const anchors = createInMemoryAuditAnchorRepository();
    let anchorAppends = 0;
    anchors.append = async (anchor) => {
      anchorAppends += 1;
      return InMemoryAuditAnchorRepository.prototype.append.call(anchors, anchor);
    };
    // An AuditAnchorService exists over the same stores, but recording
    // events must go nowhere near the anchor chain.
    const audit = new AuditService(events);

    await audit.record(input('a', 'e-1'));
    await audit.record(input('b', 'e-2'));

    expect(anchorAppends).toBe(0);
    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 2 });
  });

  it('audit append path is unaffected when anchoring is broken', async () => {
    const events = new TruncatableAuditRepository();
    const anchors = createInMemoryAuditAnchorRepository();
    anchors.append = async () => {
      throw new Error('anchors store on fire');
    };
    const audit = new AuditService(events);
    const service = new AuditAnchorService(events, anchors, {}, null);

    // The audit append path never anchors, so it is unaffected…
    await expect(audit.record(input('a', 'e-1'))).resolves.toMatchObject({ action: 'a' });
    // …while the anchor attempt itself fails loudly.
    await expect(service.createAnchor()).rejects.toThrow('anchors store on fire');
  });
});

describe('AuditAnchorService verification', () => {
  it('detects tail truncation after an anchor (event count regression)', async () => {
    const { events, audit, service } = build();
    for (let i = 0; i < 5; i += 1) {
      await audit.record(input(`bulk.${i}`, `e-${i}`));
    }
    const anchor = await service.createAnchor();

    // Attacker (or bug) with DB write deletes the last 2 events.
    events.truncate(3);

    const result = await service.verifyAnchors();
    expect(result.valid).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.gap).toMatchObject({
      reason: 'event_count_regression',
      anchorId: anchor.id,
      anchoredThroughEventId: anchor.anchoredThroughEventId,
      anchoredEventCount: 5,
      actualEventCount: 3
    });
  });

  it('detects truncation + valid re-extension (the migration 043 residual attack)', async () => {
    const { events, audit, service } = build();
    for (let i = 0; i < 5; i += 1) {
      await audit.record(input(`bulk.${i}`, `e-${i}`));
    }
    const anchor = await service.createAnchor();

    // Attacker deletes the last 2 events AND re-extends from the prefix so
    // the shortened-then-rewritten chain is internally valid again (same
    // length, different events — undetectable without the anchor).
    events.truncate(3);
    await audit.record(input('attacker.cover_up', 'e-x'));
    await audit.record(input('attacker.cover_up', 'e-y'));
    const chainCheck = await audit.verify();
    expect(chainCheck.valid).toBe(true); // event chain alone looks fine!

    const result = await service.verifyAnchors();
    expect(result.valid).toBe(false);
    expect(result.gap).toMatchObject({
      reason: 'anchor_tip_missing',
      anchorId: anchor.id,
      anchoredThroughEventId: anchor.anchoredThroughEventId,
      anchoredEventCount: 5,
      actualEventCount: 5,
      currentTipEventId: expect.any(String)
    });
    expect(result.gap?.currentTipEventId).not.toBe(anchor.anchoredThroughEventId);
  });

  it('detects tampering with an anchor payload', async () => {
    const { anchors, audit, service } = build();
    await audit.record(input('a', 'e-1'));
    const anchor = await service.createAnchor();
    await audit.record(input('b', 'e-2'));

    // Attacker rewrites the notarized count in the anchors table.
    (await anchors.list())[0].eventCount = 99;

    const result = await service.verifyAnchors();
    expect(result.valid).toBe(false);
    expect(result.brokenAnchorAt).toBe(anchor.id);
  });

  it('detects a rewritten anchor-chain link', async () => {
    const { anchors, audit, service } = build();
    await audit.record(input('a', 'e-1'));
    await service.createAnchor();
    await audit.record(input('b', 'e-2'));
    const second = await service.createAnchor();

    (await anchors.list())[1].prevAnchorHash = GENESIS_HASH;

    const result = await service.verifyAnchors();
    expect(result.valid).toBe(false);
    expect(result.brokenAnchorAt).toBe(second.id);
    expect(result.checked).toBe(1);
  });

  it('accepts new events appended after an anchor (no false positive)', async () => {
    const { audit, service } = build();
    await audit.record(input('a', 'e-1'));
    await service.createAnchor();
    await audit.record(input('b', 'e-2'));
    await audit.record(input('c', 'e-3'));
    await expect(service.verifyAnchors()).resolves.toEqual({ valid: true, checked: 1 });
  });

  it('verifies an empty anchor log as valid', async () => {
    const { service } = build();
    await expect(service.verifyAnchors()).resolves.toEqual({ valid: true, checked: 0 });
  });
});

describe('AuditAnchorService scheduler (AUDIT_ANCHOR_INTERVAL_MS)', () => {
  const services: AuditAnchorService[] = [];
  afterEach(() => {
    for (const service of services.splice(0)) {
      service.onModuleDestroy();
    }
  });

  it('creates anchors on the configured interval without crashing boot', async () => {
    const { audit, service } = build({ AUDIT_ANCHOR_INTERVAL_MS: '15' });
    services.push(service);
    await audit.record(input('a', 'e-1'));

    expect(() => service.onModuleInit()).not.toThrow();
    await sleep(60);

    expect((await service.listAnchors()).length).toBeGreaterThanOrEqual(1);
  });

  it('stays disabled by default (no env) and on malformed values', async () => {
    const { audit, service } = build();
    services.push(service);
    await audit.record(input('a', 'e-1'));
    service.onModuleInit();
    const malformed = build({ AUDIT_ANCHOR_INTERVAL_MS: 'soon' });
    services.push(malformed.service);
    expect(() => malformed.service.onModuleInit()).not.toThrow();

    await sleep(40);

    expect(await service.listAnchors()).toEqual([]);
    expect(await malformed.service.listAnchors()).toEqual([]);
  });
});

describe('audit anchor sink (AUDIT_ANCHOR_SINK)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('createAnchorSink: unset disables, file: selects the JSONL sink, unknown schemes fail lazily', () => {
    expect(createAnchorSink({})).toBeNull();
    expect(createAnchorSink({ AUDIT_ANCHOR_SINK: 'file:/tmp/x.jsonl' })).toBeInstanceOf(
      FileAnchorSink
    );
    expect(createAnchorSink({ AUDIT_ANCHOR_SINK: 'https://log.example' })).toBeInstanceOf(
      FailingAnchorSink
    );
    expect(createAnchorSink({ AUDIT_ANCHOR_SINK: 'file:' })).toBeInstanceOf(FailingAnchorSink);
  });

  it('appends each anchor as one JSON line to the file sink', async () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-anchor-sink-'));
    const path = join(dir, 'anchors.jsonl');
    // No sink override: the service resolves AUDIT_ANCHOR_SINK lazily.
    const { audit, events, anchors } = build();
    const service = new AuditAnchorService(events, anchors, { AUDIT_ANCHOR_SINK: `file:${path}` });
    await audit.record(input('a', 'e-1'));
    const first = await service.createAnchor();
    await audit.record(input('b', 'e-2'));
    const second = await service.createAnchor();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const shipped = lines.map((line) => JSON.parse(line));
    expect(shipped[0]).toMatchObject({
      id: first.id,
      anchorHash: first.anchorHash,
      prevAnchorHash: GENESIS_HASH
    });
    expect(shipped[1]).toMatchObject({ id: second.id, prevAnchorHash: first.anchorHash });
    expect(Object.keys(shipped[0])).toEqual([
      'id',
      'anchoredThroughEventId',
      'tipHash',
      'eventCount',
      'prevAnchorHash',
      'anchorHash',
      'createdAt'
    ]);
  });

  it('surfaces an unknown sink scheme on the first anchor attempt, never at boot', async () => {
    const env = { AUDIT_ANCHOR_SINK: 's3://bucket/anchors' };
    const { audit, events, anchors } = build();
    const service = new AuditAnchorService(events, anchors, env);
    // Boot and scheduler setup must not fail on the misconfiguration.
    expect(() => service.onModuleInit()).not.toThrow();
    service.onModuleDestroy();

    await audit.record(input('a', 'e-1'));
    const attempt = service.createAnchor();
    await expect(attempt).rejects.toBeInstanceOf(AnchorSinkConfigError);
    await expect(attempt).rejects.toThrow(/unsupported AUDIT_ANCHOR_SINK scheme 's3'/);
    // The anchor itself was still persisted (fail happens after the insert).
    expect(await anchors.list()).toHaveLength(1);
  });
});
