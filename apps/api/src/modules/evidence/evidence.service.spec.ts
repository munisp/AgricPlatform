import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { EvidenceItem, User } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryEvidenceItemRepository } from '../../database/repositories/evidence-item.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import type { CaseParticipantLookup } from './case-participants.js';
import { EvidenceService } from './evidence.service.js';
import type {
  EvidenceObjectStat,
  EvidenceStorageDriver,
  PresignedEvidenceUrl
} from './evidence.storage.js';

/** Deterministic in-memory blob store posing as the live driver. */
class FakeEvidenceStorage implements EvidenceStorageDriver {
  readonly name = 's3' as const;
  readonly blobs = new Map<string, EvidenceObjectStat>();
  readonly removed: string[] = [];

  presignUpload(input: {
    objectKey: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<PresignedEvidenceUrl> {
    return Promise.resolve({
      url: `https://storage.test/${input.objectKey}?sig=fake`,
      method: 'PUT',
      headers: { 'Content-Type': input.mime, 'x-amz-meta-sha256': input.sha256 },
      expiresAt: new Date(Date.now() + 900_000).toISOString()
    });
  }

  /** Test helper: the client PUTs the blob (sha256 pinned from the presign). */
  clientPut(objectKey: string, sizeBytes: number, sha256: string | null): void {
    this.blobs.set(objectKey, { sizeBytes, sha256 });
  }

  stat(objectKey: string): Promise<EvidenceObjectStat | null> {
    return Promise.resolve(this.blobs.get(objectKey) ?? null);
  }

  presignDownload(objectKey: string): Promise<PresignedEvidenceUrl> {
    return Promise.resolve({
      url: `https://storage.test/${objectKey}?sig=get`,
      method: 'GET',
      headers: {},
      expiresAt: new Date(Date.now() + 900_000).toISOString()
    });
  }

  remove(objectKey: string): Promise<void> {
    this.removed.push(objectKey);
    this.blobs.delete(objectKey);
    return Promise.resolve();
  }
}

/** Failing storage: every op errors (stub behaviour under test control). */
class UnavailableStorage extends FakeEvidenceStorage {
  override presignUpload(): Promise<PresignedEvidenceUrl> {
    return Promise.reject(new ServiceUnavailableException('storage down'));
  }
  override remove(): Promise<void> {
    return Promise.reject(new ServiceUnavailableException('storage down'));
  }
}

class MapCaseParticipants implements CaseParticipantLookup {
  readonly cases = new Map<string, string[]>();
  set(caseType: string, caseId: string, parties: string[]): void {
    this.cases.set(`${caseType}:${caseId}`, parties);
  }
  participants(caseType: string, caseId: string): Promise<string[]> {
    return Promise.resolve(this.cases.get(`${caseType}:${caseId}`) ?? []);
  }
}

class RecordingTelemetry extends TelemetryService {
  readonly recorded: { name: string; value: number; attributes: Record<string, unknown> }[] = [];
  override increment(name: string, value = 1, attributes: Record<string, unknown> = {}): void {
    this.recorded.push({ name, value, attributes });
  }
  count(name: string): number {
    return this.recorded.filter((c) => c.name === name).reduce((sum, c) => sum + c.value, 0);
  }
}

const buyer = { id: 'user-buyer', roles: ['farmer'] } as unknown as User;
const seller = { id: 'user-seller', roles: ['aggregator'] } as unknown as User;
const stranger = { id: 'user-stranger', roles: ['farmer'] } as unknown as User;
const admin = { id: 'user-admin', roles: ['admin'] } as unknown as User;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function makeService(storage: FakeEvidenceStorage = new FakeEvidenceStorage()) {
  const items = createInMemoryEvidenceItemRepository();
  const cases = new MapCaseParticipants();
  const audit = new AuditService(createInMemoryAuditRepository());
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const telemetry = new RecordingTelemetry();
  const service = new EvidenceService(items, storage, cases, audit, events, telemetry);
  return { service, items, cases, audit, outbox, events, telemetry, storage };
}

function seedEscrowCase(cases: MapCaseParticipants): void {
  cases.set('escrow', 'escrow-1', [buyer.id, seller.id]);
}

const declaration = { mime: 'image/jpeg', sizeBytes: 1024, sha256: SHA_A };

async function uploadOne(
  service: EvidenceService,
  storage: FakeEvidenceStorage,
  actor: User = buyer,
  caseId = 'escrow-1',
  decl = declaration
): Promise<EvidenceItem> {
  const init = await service.initiateUpload(actor, 'escrow', caseId, decl);
  storage.clientPut(init.objectKey, decl.sizeBytes, decl.sha256);
  return service.confirmItem(actor, 'escrow', caseId, {
    objectKey: init.objectKey,
    ...decl
  });
}

describe('EvidenceService — case-participant guard matrix', () => {
  it('admits both escrow parties (buyer and seller)', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    await expect(uploadOne(service, storage, buyer)).resolves.toMatchObject({
      uploaderId: buyer.id,
      status: 'active'
    });
    await expect(
      uploadOne(service, storage, seller, 'escrow-1', { ...declaration, sha256: SHA_B })
    ).resolves.toMatchObject({ uploaderId: seller.id });
  });

  it('rejects a non-party uploader (403)', async () => {
    const { service, cases } = makeService();
    seedEscrowCase(cases);
    await expect(service.initiateUpload(stranger, 'escrow', 'escrow-1', declaration)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('rejects an unknown case (404, fail closed)', async () => {
    const { service } = makeService();
    await expect(service.initiateUpload(buyer, 'escrow', 'escrow-404', declaration)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('fails closed for pool cases (no pool registry in this tree)', async () => {
    const { service } = makeService();
    await expect(service.initiateUpload(buyer, 'pool', 'pool-1', declaration)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('does not give admins upload rights (uploads are party-only)', async () => {
    const { service, cases } = makeService();
    seedEscrowCase(cases);
    await expect(service.initiateUpload(admin, 'escrow', 'escrow-1', declaration)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('lets parties and admin read the chain, strangers not', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    await uploadOne(service, storage, buyer);
    await expect(service.getChain(seller, 'escrow', 'escrow-1')).resolves.toMatchObject({
      continuity: { valid: true }
    });
    await expect(service.getChain(admin, 'escrow', 'escrow-1')).resolves.toMatchObject({
      continuity: { valid: true }
    });
    await expect(service.getChain(stranger, 'escrow', 'escrow-1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('EvidenceService — fail-closed upload flow', () => {
  it('stub storage: initiate answers 503 and NO row is created', async () => {
    const storage = new UnavailableStorage();
    const { service, cases, items } = makeService(storage);
    seedEscrowCase(cases);
    await expect(service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(await items.listCaseItems('escrow', 'escrow-1')).toEqual([]);
  });

  it('confirm without an uploaded blob answers 404 and records nothing', async () => {
    const { service, cases, items } = makeService();
    seedEscrowCase(cases);
    const init = await service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration);
    await expect(
      service.confirmItem(buyer, 'escrow', 'escrow-1', { objectKey: init.objectKey, ...declaration })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await items.listCaseItems('escrow', 'escrow-1')).toEqual([]);
  });

  it('confirm with a size mismatch answers 422 and records nothing', async () => {
    const { service, cases, items, storage } = makeService();
    seedEscrowCase(cases);
    const init = await service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration);
    storage.clientPut(init.objectKey, 2048, SHA_A);
    await expect(
      service.confirmItem(buyer, 'escrow', 'escrow-1', { objectKey: init.objectKey, ...declaration })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await items.listCaseItems('escrow', 'escrow-1')).toEqual([]);
  });

  it('confirm with a sha256 mismatch answers 422 and records nothing', async () => {
    const { service, cases, items, storage } = makeService();
    seedEscrowCase(cases);
    const init = await service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration);
    storage.clientPut(init.objectKey, 1024, SHA_B);
    await expect(
      service.confirmItem(buyer, 'escrow', 'escrow-1', { objectKey: init.objectKey, ...declaration })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await items.listCaseItems('escrow', 'escrow-1')).toEqual([]);
  });

  it('confirm with an unverifiable blob (no pinned sha256) answers 422 and records nothing', async () => {
    const { service, cases, items, storage } = makeService();
    seedEscrowCase(cases);
    const init = await service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration);
    storage.clientPut(init.objectKey, 1024, null);
    await expect(
      service.confirmItem(buyer, 'escrow', 'escrow-1', { objectKey: init.objectKey, ...declaration })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await items.listCaseItems('escrow', 'escrow-1')).toEqual([]);
  });

  it('rejects object keys not issued by this server/case (400)', async () => {
    const { service, cases } = makeService();
    seedEscrowCase(cases);
    await expect(
      service.confirmItem(buyer, 'escrow', 'escrow-1', {
        objectKey: 'somewhere/else/evi-00000000-0000-0000-0000-000000000000',
        ...declaration
      })
    ).rejects.toThrow(/not issued/);
  });

  it('validates the blob declaration', async () => {
    const { service, cases } = makeService();
    seedEscrowCase(cases);
    await expect(
      service.initiateUpload(buyer, 'escrow', 'escrow-1', { ...declaration, sizeBytes: 0 })
    ).rejects.toThrow(/sizeBytes/);
    await expect(
      service.initiateUpload(buyer, 'escrow', 'escrow-1', { ...declaration, sha256: 'xyz' })
    ).rejects.toThrow(/sha256/);
    await expect(
      service.initiateUpload(buyer, 'escrow', 'escrow-1', { ...declaration, mime: 'jpeg' })
    ).rejects.toThrow(/mime/);
  });
});

describe('EvidenceService — hash-chained recording (upload -> dispute view integration)', () => {
  it('appends a genesis item and a linked second item; chain view proves continuity', async () => {
    const { service, cases, storage, telemetry } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    const second = await uploadOne(service, storage, seller, 'escrow-1', {
      ...declaration,
      sha256: SHA_B,
      sizeBytes: 2048
    });
    expect(second.prevHash).toBe(first.itemHash);
    const view = await service.getChain(admin, 'escrow', 'escrow-1');
    expect(view.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(view.continuity).toMatchObject({ valid: true, checked: 2 });
    expect(view.chainHeadHash).toBe(second.itemHash);
    expect(view.items.every((item) => item.integrity === 'valid')).toBe(true);
    expect(telemetry.count('evidence.items_total')).toBe(2);
    expect(telemetry.count('evidence.chain_breaks_detected_total')).toBe(0);
  });

  it('chains are per case: another case restarts at genesis', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    cases.set('escrow', 'escrow-2', [buyer.id]);
    await uploadOne(service, storage, buyer);
    const other = await uploadOne(service, storage, buyer, 'escrow-2');
    expect(other.prevHash).toBe('0'.repeat(64));
  });

  it('confirm replay is idempotent; conflicting replay is a 409', async () => {
    const { service, cases, storage, items } = makeService();
    seedEscrowCase(cases);
    const init = await service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration);
    storage.clientPut(init.objectKey, 1024, SHA_A);
    const first = await service.confirmItem(buyer, 'escrow', 'escrow-1', {
      objectKey: init.objectKey,
      ...declaration
    });
    const replayed = await service.confirmItem(buyer, 'escrow', 'escrow-1', {
      objectKey: init.objectKey,
      ...declaration
    });
    expect(replayed.id).toBe(first.id);
    expect(await items.listCaseItems('escrow', 'escrow-1')).toHaveLength(1);
    await expect(
      service.confirmItem(buyer, 'escrow', 'escrow-1', {
        objectKey: init.objectKey,
        ...declaration,
        sha256: SHA_B
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('publishes evidence.item.added through the outbox', async () => {
    const { service, cases, storage, outbox } = makeService();
    seedEscrowCase(cases);
    const item = await uploadOne(service, storage, buyer);
    const published = await outbox.list();
    expect(published.map((event) => event.name)).toContain('evidence.item.added');
    const added = published.find((event) => event.name === 'evidence.item.added');
    expect(added?.payload).toMatchObject({ itemId: item.id, caseType: 'escrow', caseId: 'escrow-1' });
  });
});

describe('EvidenceService — tamper evidence', () => {
  /** Simulates an out-of-band DB rewrite via the live stored reference. */
  function rewriteSize(item: EvidenceItem, sizeBytes: number): void {
    (item as { sizeBytes: number }).sizeBytes = sizeBytes;
  }

  it('chain view flags a rewritten item, counts the break, and audits it', async () => {
    const { service, cases, storage, telemetry, audit } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    await uploadOne(service, storage, seller, 'escrow-1', { ...declaration, sha256: SHA_B });
    rewriteSize(first, 5); // tamper
    const view = await service.getChain(admin, 'escrow', 'escrow-1');
    expect(view.continuity.valid).toBe(false);
    expect(view.continuity.brokenAt).toBe(first.id);
    expect(view.items[0].integrity).toBe('tampered');
    expect(telemetry.count('evidence.chain_breaks_detected_total')).toBe(1);
    const audited = await audit.list();
    expect(audited.map((event) => event.action)).toContain('evidence.chain_break_detected');
  });

  it('download-url NEVER serves a tampered item (409, flagged)', async () => {
    const { service, cases, storage, telemetry } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    rewriteSize(first, 5);
    await expect(service.downloadUrl(admin, first.id)).rejects.toBeInstanceOf(ConflictException);
    expect(telemetry.count('evidence.chain_breaks_detected_total')).toBe(1);
  });

  it('download-url serves a clean item to a party', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    const result = await service.downloadUrl(seller, first.id);
    expect(result.item.integrity).toBe('valid');
    expect(result.download.url).toContain(first.objectKey);
  });
});

describe('EvidenceService — seal (admin freezes head into the audit chain)', () => {
  it('seals the case: items sealed, head frozen in an audit event, event published', async () => {
    const { service, cases, storage, audit, outbox, items } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    const second = await uploadOne(service, storage, seller, 'escrow-1', {
      ...declaration,
      sha256: SHA_B
    });
    const seal = await service.sealCase(admin, 'escrow', 'escrow-1');
    expect(seal.chainHeadHash).toBe(second.itemHash);
    expect(seal.itemCount).toBe(2);
    expect(seal.sealedCount).toBe(2);
    const persisted = await items.listCaseItems('escrow', 'escrow-1');
    expect(persisted.map((item) => item.status)).toEqual(['sealed', 'sealed']);
    // The head hash is frozen into the platform audit chain (047 pattern).
    const auditEvents = await audit.list();
    const sealEvent = auditEvents.find((event) => event.id === seal.auditEventId);
    expect(sealEvent?.action).toBe('evidence.case.sealed');
    expect(sealEvent?.metadata).toMatchObject({
      chainHeadHash: second.itemHash,
      itemCount: 2
    });
    expect((await audit.verify()).valid).toBe(true);
    const published = await outbox.list();
    expect(published.map((event) => event.name)).toContain('evidence.case.sealed');
    // Chain stays verifiable after sealing (status is outside the hash).
    const view = await service.getChain(admin, 'escrow', 'escrow-1');
    expect(view.continuity.valid).toBe(true);
    expect(first.itemHash).toBe(persisted[0].itemHash);
  });

  it('rejects uploads to a sealed case (409) — the frozen head cannot move', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    await uploadOne(service, storage, buyer);
    await service.sealCase(admin, 'escrow', 'escrow-1');
    await expect(service.initiateUpload(buyer, 'escrow', 'escrow-1', declaration)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('seal is admin-only', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    await uploadOne(service, storage, buyer);
    await expect(service.sealCase(buyer, 'escrow', 'escrow-1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('refuses to seal a chain that does not verify', async () => {
    const { service, cases, storage, telemetry } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    (first as { sha256: string }).sha256 = SHA_B; // tamper
    await expect(service.sealCase(admin, 'escrow', 'escrow-1')).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(telemetry.count('evidence.chain_breaks_detected_total')).toBe(1);
  });
});

describe('EvidenceService — NDPA expunge tombstones', () => {
  it('expunge deletes the blob, keeps the hash tombstone, chain stays verifiable', async () => {
    const { service, cases, storage, outbox, telemetry } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    await uploadOne(service, storage, seller, 'escrow-1', { ...declaration, sha256: SHA_B });
    const tombstone = await service.expungeItem(admin, 'escrow', 'escrow-1', first.id);
    expect(tombstone.status).toBe('expunged');
    expect(tombstone.itemHash).toBe(first.itemHash); // hash fields retained
    expect(storage.removed).toEqual([first.objectKey]);
    expect(storage.blobs.has(first.objectKey)).toBe(false);
    const view = await service.getChain(admin, 'escrow', 'escrow-1');
    expect(view.continuity.valid).toBe(true); // chain continuity preserved
    expect(view.items[0].status).toBe('expunged');
    const published = await outbox.list();
    expect(published.map((event) => event.name)).toContain('evidence.item.expunged');
    expect(telemetry.count('evidence.items_expunged_total')).toBe(1);
    // Expunged blobs are gone, not served.
    await expect(service.downloadUrl(admin, first.id)).rejects.toBeInstanceOf(GoneException);
    // Idempotent replay.
    const again = await service.expungeItem(admin, 'escrow', 'escrow-1', first.id);
    expect(again.status).toBe('expunged');
    expect(storage.removed).toHaveLength(1);
  });

  it('expunge fails closed: storage failure -> 503, status untouched', async () => {
    const { service, cases, storage, items } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    storage.remove = () => Promise.reject(new ServiceUnavailableException('storage down'));
    await expect(
      service.expungeItem(admin, 'escrow', 'escrow-1', first.id)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect((await items.findById(first.id))?.status).toBe('active');
  });

  it('expunge is admin-only', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    const first = await uploadOne(service, storage, buyer);
    await expect(
      service.expungeItem(buyer, 'escrow', 'escrow-1', first.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("privacy sweep expunges all of a user's uploads across cases", async () => {
    const { service, cases, storage, items } = makeService();
    seedEscrowCase(cases);
    cases.set('escrow', 'escrow-2', [buyer.id]);
    const one = await uploadOne(service, storage, buyer);
    const two = await uploadOne(service, storage, buyer, 'escrow-2');
    await uploadOne(service, storage, seller, 'escrow-1', { ...declaration, sha256: SHA_B });
    const sweep = await service.expungeForUser(buyer.id, admin.id);
    expect(sweep).toEqual({ userId: buyer.id, expunged: 2, failed: 0 });
    expect((await items.findById(one.id))?.status).toBe('expunged');
    expect((await items.findById(two.id))?.status).toBe('expunged');
    // Both case chains remain verifiable across the tombstones.
    expect((await service.getChain(admin, 'escrow', 'escrow-1')).continuity.valid).toBe(true);
    expect((await service.getChain(admin, 'escrow', 'escrow-2')).continuity.valid).toBe(true);
  });

  it('privacy sweep reports per-item failures honestly', async () => {
    const { service, cases, storage } = makeService();
    seedEscrowCase(cases);
    await uploadOne(service, storage, buyer);
    storage.remove = () => Promise.reject(new ServiceUnavailableException('storage down'));
    const sweep = await service.expungeForUser(buyer.id, admin.id);
    expect(sweep.expunged).toBe(0);
    expect(sweep.failed).toBe(1);
  });
});
