import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException
} from '@nestjs/common';
import type { EvidenceCaseType, EvidenceItem, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EVIDENCE_ITEM_REPOSITORY } from '../../database/persistence.tokens.js';
import type { EvidenceItemRepository } from '../../database/repositories/evidence-item.repository.js';
import {
  CASE_PARTICIPANT_LOOKUP,
  type CaseParticipantLookup
} from './case-participants.js';
import {
  chainHead,
  evidenceItemPayload,
  evidenceSizeClass,
  hashEvidenceItem,
  verifyEvidenceChain,
  type EvidenceChainVerification
} from './evidence-hash.js';
import {
  EVIDENCE_STORAGE_DRIVER,
  type EvidenceStorageDriver,
  type PresignedEvidenceUrl
} from './evidence.storage.js';

export const EVIDENCE_CASE_TYPES: readonly EvidenceCaseType[] = [
  'escrow',
  'vsla',
  'insurance',
  'pool'
];

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface InitiateUploadInput {
  mime: string;
  sizeBytes: number;
  /** Client-computed lowercase hex sha256 of the blob bytes. */
  sha256: string;
  capturedAt?: string;
}

export interface ConfirmItemInput {
  /** objectKey returned by initiateUpload — embeds case + item identity. */
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mime: string;
  capturedAt?: string;
}

export interface InitiateUploadResult {
  itemId: string;
  objectKey: string;
  upload: PresignedEvidenceUrl;
}

/** Chain view item: integrity flag is computed on every read (never cached). */
export interface EvidenceChainItem extends EvidenceItem {
  integrity: 'valid' | 'tampered';
}

export interface EvidenceChainView {
  caseType: EvidenceCaseType;
  caseId: string;
  items: EvidenceChainItem[];
  /** Chain continuity proof, recomputed on every read. */
  continuity: EvidenceChainVerification;
  /** Current chain head hash (genesis for an empty case). */
  chainHeadHash: string;
}

export interface SealResult {
  caseType: EvidenceCaseType;
  caseId: string;
  chainHeadHash: string;
  itemCount: number;
  /** Items moved active -> sealed by THIS call (0 on re-seal). */
  sealedCount: number;
  /** Audit-chain event id that froze the head hash (migration-047 pattern). */
  auditEventId: string;
}

export interface ExpungeSweepResult {
  userId: string;
  expunged: number;
  /** Blob removals that failed — surfaced honestly, never swallowed. */
  failed: number;
}

/**
 * Evidence Locker (Stage 27 Innovation 13): hash-chained dispute evidence
 * packs pinned to escrow/vsla/insurance/pool cases.
 *
 * Flow (fail-closed at every step):
 *   1. initiateUpload — case-participant guard, then a presigned PUT whose
 *      signed headers pin the declared sha256. No row exists yet.
 *   2. Client PUTs the blob straight to object storage.
 *   3. confirmItem — the blob is stat'ed and MUST exist with the declared
 *      size and the pinned sha256 before the hash-chained row is appended:
 *      no metadata-without-blob rows that would fabricate provenance.
 *
 * Tamper evidence: every read recomputes the chain (verifyEvidenceChain);
 * a hash/link mismatch flags the item (integrity='tampered', audit event,
 * evidence.chain_breaks_detected_total) and it is NEVER served as valid —
 * download-url answers 409 for it.
 *
 * Sealing (admin) freezes the case chain head hash into the platform audit
 * chain (admin.audit_events, anchor-notarized per migration 047) and CAS-
 * transitions the case's items to 'sealed'; uploads to a sealed case are
 * rejected (409) so the frozen head cannot be silently superseded.
 *
 * NDPA expunge: the object is deleted from storage FIRST (failure -> 503,
 * status unchanged), then the row becomes a hash tombstone
 * (status='expunged', hash fields retained) so chain continuity survives
 * erasure — the privacy export/delete doctrine applied to blobs.
 */
@Injectable()
export class EvidenceService {
  private readonly telemetry: TelemetryService;

  constructor(
    @Inject(EVIDENCE_ITEM_REPOSITORY) private readonly items: EvidenceItemRepository,
    @Inject(EVIDENCE_STORAGE_DRIVER) private readonly storage: EvidenceStorageDriver,
    @Inject(CASE_PARTICIPANT_LOOKUP) private readonly cases: CaseParticipantLookup,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Optional() telemetry?: TelemetryService
  ) {
    this.telemetry = telemetry ?? new TelemetryService();
  }

  // ------------------------------------------------------------- uploads

  async initiateUpload(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string,
    input: InitiateUploadInput
  ): Promise<InitiateUploadResult> {
    await this.requireCaseParty(actor, caseType, caseId);
    this.validateBlobDeclaration(input);
    await this.requireCaseNotSealed(caseType, caseId);
    const itemId = newId('evi');
    const objectKey = this.objectKeyFor(caseType, caseId, itemId);
    // Stub storage rejects here with 503 — before any row could exist.
    const upload = await this.storage.presignUpload({
      objectKey,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256
    });
    return { itemId, objectKey, upload };
  }

  async confirmItem(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string,
    input: ConfirmItemInput
  ): Promise<EvidenceItem> {
    await this.requireCaseParty(actor, caseType, caseId);
    this.validateBlobDeclaration(input);
    const itemId = this.itemIdFromObjectKey(caseType, caseId, input.objectKey);

    // Idempotent confirm replay: a recorded object returns its row when the
    // declaration matches exactly; anything else is a conflict, never a
    // second row (UNIQUE object_key is the database backstop).
    const existing = await this.items.findByObjectKey(input.objectKey);
    if (existing) {
      const sameDeclaration =
        existing.uploaderId === actor.id &&
        existing.sha256 === input.sha256 &&
        existing.sizeBytes === input.sizeBytes &&
        existing.mime === input.mime;
      if (!sameDeclaration) {
        throw new ConflictException(
          `Evidence object '${input.objectKey}' is already recorded with different provenance`
        );
      }
      return existing;
    }
    await this.requireCaseNotSealed(caseType, caseId);

    // Prove the blob BEFORE any row exists (fail-closed provenance).
    const stat = await this.storage.stat(input.objectKey);
    if (!stat) {
      throw new NotFoundException(
        `No blob at '${input.objectKey}' — upload the bytes to the presigned URL first`
      );
    }
    if (stat.sizeBytes !== input.sizeBytes) {
      throw new UnprocessableEntityException(
        `Blob size ${stat.sizeBytes} does not match declared ${input.sizeBytes} — not recording`
      );
    }
    if (stat.sha256 === null) {
      throw new UnprocessableEntityException(
        `Blob at '${input.objectKey}' carries no pinned sha256 metadata — provenance is ` +
          'unverifiable, so no evidence row is recorded'
      );
    }
    if (stat.sha256 !== input.sha256) {
      throw new UnprocessableEntityException(
        'Blob sha256 does not match the declared hash — not recording'
      );
    }

    const uploadedAt = new Date().toISOString();
    const item = await this.telemetry.withSpan(
      'evidence.item.record',
      { case_type: caseType, size_class: evidenceSizeClass(input.sizeBytes) },
      () =>
        this.items.append({
          id: itemId,
          caseType,
          caseId,
          uploaderId: actor.id,
          objectKey: input.objectKey,
          sha256: input.sha256,
          capturedAt: input.capturedAt ?? null,
          uploadedAt,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          status: 'active'
        })
    );
    this.telemetry.increment('evidence.items_total', 1, { case_type: caseType });
    await this.events.publish(
      'evidence.item.added',
      {
        itemId: item.id,
        caseType,
        caseId,
        objectKey: item.objectKey,
        sha256: item.sha256,
        sizeBytes: item.sizeBytes
      },
      actor.id
    );
    return item;
  }

  // ---------------------------------------------------------------- reads

  async getChain(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string
  ): Promise<EvidenceChainView> {
    await this.requireCasePartyOrAdmin(actor, caseType, caseId);
    const items = await this.items.listCaseItems(caseType, caseId);
    const continuity = verifyEvidenceChain(items);
    if (!continuity.valid) {
      await this.flagChainBreak(actor, caseType, caseId, continuity);
    }
    const tampered = new Set(continuity.tamperedItemIds);
    return {
      caseType,
      caseId,
      items: items.map((item) => ({
        ...item,
        integrity: tampered.has(item.id) ? ('tampered' as const) : ('valid' as const)
      })),
      continuity,
      chainHeadHash: chainHead(items)
    };
  }

  /**
   * Presigned download URL — gated on per-item integrity. A tampered item
   * (payload edit or broken link up to it) is flagged and NEVER served.
   */
  async downloadUrl(
    actor: User,
    itemId: string
  ): Promise<{ item: EvidenceChainItem; download: PresignedEvidenceUrl }> {
    const item = await this.items.findById(itemId);
    if (!item) {
      throw new NotFoundException(`Evidence item '${itemId}' not found`);
    }
    await this.requireCasePartyOrAdmin(actor, item.caseType, item.caseId);
    if (item.status === 'expunged') {
      throw new GoneException(
        'Evidence item was expunged under an NDPA deletion request; only its hash tombstone remains'
      );
    }
    const integrity = await this.itemIntegrity(actor, item);
    if (integrity === 'tampered') {
      throw new ConflictException(
        `Evidence item '${itemId}' failed hash-chain verification and is flagged as tampered — ` +
          'it is never served as valid evidence'
      );
    }
    const download = await this.storage.presignDownload(item.objectKey);
    return { item: { ...item, integrity }, download };
  }

  // ----------------------------------------------------------------- seal

  async sealCase(actor: User, caseType: EvidenceCaseType, caseId: string): Promise<SealResult> {
    if (!this.isAdmin(actor)) {
      throw new ForbiddenException('Only platform admins can seal an evidence case');
    }
    const items = await this.items.listCaseItems(caseType, caseId);
    if (items.length === 0) {
      throw new NotFoundException(`Evidence case '${caseType}:${caseId}' has no items to seal`);
    }
    const continuity = verifyEvidenceChain(items);
    if (!continuity.valid) {
      await this.flagChainBreak(actor, caseType, caseId, continuity);
      throw new ConflictException(
        `Evidence chain for '${caseType}:${caseId}' is broken at '${continuity.brokenAt}' — ` +
          'refusing to seal a chain that does not verify'
      );
    }
    const head = chainHead(items);
    const sealedCount = await this.items.sealCase(caseType, caseId);
    // Freeze the chain head into the platform audit chain (migration-047
    // anchor pattern): the audit event is hash-chained and anchor-
    // notarized, so a post-seal rewrite of the evidence chain is detectable
    // against a notarized platform-wide checkpoint.
    const auditEvent = await this.audit.record({
      actorId: actor.id,
      action: 'evidence.case.sealed',
      entityType: 'evidence_case',
      entityId: `${caseType}:${caseId}`,
      metadata: {
        caseType,
        caseId,
        chainHeadHash: head,
        itemCount: items.length,
        sealedCount
      }
    });
    this.telemetry.increment('evidence.cases_sealed_total', 1, { case_type: caseType });
    await this.events.publish(
      'evidence.case.sealed',
      { caseType, caseId, chainHeadHash: head, itemCount: items.length },
      actor.id
    );
    return {
      caseType,
      caseId,
      chainHeadHash: head,
      itemCount: items.length,
      sealedCount,
      auditEventId: auditEvent.id
    };
  }

  // -------------------------------------------------------------- expunge

  /** NDPA erasure of one item (admin/privacy flow): blob first, tombstone second. */
  async expungeItem(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string,
    itemId: string
  ): Promise<EvidenceItem> {
    if (!this.isAdmin(actor)) {
      throw new ForbiddenException('Only platform admins can expunge evidence items');
    }
    const item = await this.items.findById(itemId);
    if (!item || item.caseType !== caseType || item.caseId !== caseId) {
      throw new NotFoundException(`Evidence item '${itemId}' not found on case '${caseType}:${caseId}'`);
    }
    if (item.status === 'expunged') {
      return item; // idempotent replay of a completed erasure
    }
    // Delete the object FIRST: when storage fails (stub -> 503) the status
    // stays untouched — we never claim erasure while the blob remains.
    await this.storage.remove(item.objectKey);
    const tombstone = await this.items.transitionStatus(item.id, ['active', 'sealed'], 'expunged');
    if (!tombstone) {
      throw new ConflictException(
        `Evidence item '${itemId}' changed state concurrently — re-read and retry`
      );
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'evidence.item.expunged',
      entityType: 'evidence_item',
      entityId: item.id,
      metadata: { caseType, caseId, objectKey: item.objectKey, sha256: item.sha256 }
    });
    this.telemetry.increment('evidence.items_expunged_total', 1, { case_type: caseType });
    await this.events.publish(
      'evidence.item.expunged',
      { itemId: item.id, caseType, caseId },
      actor.id
    );
    return tombstone;
  }

  /**
   * NDPA deletion-request sweep (privacy module hook): expunge every blob
   * the user uploaded, across all cases. Tombstones keep every affected
   * chain verifiable. Per-item failures are counted and returned honestly —
   * the caller (privacy flow) logs them; a partial sweep is never reported
   * as complete.
   */
  async expungeForUser(userId: string, actorId: string): Promise<ExpungeSweepResult> {
    const uploaded = await this.items.listByUploader(userId);
    let expunged = 0;
    let failed = 0;
    for (const item of uploaded) {
      if (item.status === 'expunged') {
        continue;
      }
      try {
        await this.storage.remove(item.objectKey);
        const tombstone = await this.items.transitionStatus(
          item.id,
          ['active', 'sealed'],
          'expunged'
        );
        if (tombstone) {
          expunged += 1;
          await this.audit.record({
            actorId,
            action: 'evidence.item.expunged',
            entityType: 'evidence_item',
            entityId: item.id,
            metadata: {
              caseType: item.caseType,
              caseId: item.caseId,
              objectKey: item.objectKey,
              sha256: item.sha256,
              sweep: 'privacy.user.deletion'
            }
          });
          await this.events.publish(
            'evidence.item.expunged',
            { itemId: item.id, caseType: item.caseType, caseId: item.caseId },
            actorId
          );
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    if (expunged > 0 || failed > 0) {
      this.telemetry.increment('evidence.items_expunged_total', expunged, {
        sweep: 'privacy.user.deletion'
      });
    }
    return { userId, expunged, failed };
  }

  // -------------------------------------------------------------- helpers

  private isAdmin(actor: User): boolean {
    return actor.roles.includes('admin');
  }

  private async requireCaseParty(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string
  ): Promise<void> {
    const parties = await this.cases.participants(caseType, caseId);
    if (parties.length === 0) {
      // Unknown case (or a 'pool' case before the pool registry lands):
      // fail closed as not-found rather than admitting unverifiable uploads.
      throw new NotFoundException(`Evidence case '${caseType}:${caseId}' not found`);
    }
    if (!parties.includes(actor.id)) {
      throw new ForbiddenException(
        `Only a party to case '${caseType}:${caseId}' can add evidence to it`
      );
    }
  }

  private async requireCasePartyOrAdmin(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string
  ): Promise<void> {
    if (this.isAdmin(actor)) {
      return;
    }
    await this.requireCaseParty(actor, caseType, caseId);
  }

  /** Uploads to a sealed case are rejected: the frozen head must not move. */
  private async requireCaseNotSealed(
    caseType: EvidenceCaseType,
    caseId: string
  ): Promise<void> {
    const items = await this.items.listCaseItems(caseType, caseId);
    if (items.some((item) => item.status === 'sealed')) {
      throw new ConflictException(
        `Evidence case '${caseType}:${caseId}' is sealed — its chain head is frozen`
      );
    }
  }

  private validateBlobDeclaration(input: {
    mime: string;
    sizeBytes: number;
    sha256: string;
    capturedAt?: string;
  }): void {
    if (!input.mime || !input.mime.includes('/')) {
      throw new BadRequestException('mime must be a media type like image/jpeg');
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new BadRequestException('sizeBytes must be a positive integer');
    }
    if (!SHA256_HEX.test(input.sha256)) {
      throw new BadRequestException('sha256 must be 64 lowercase hex chars');
    }
    if (input.capturedAt !== undefined && Number.isNaN(Date.parse(input.capturedAt))) {
      throw new BadRequestException('capturedAt must be an ISO-8601 timestamp');
    }
  }

  private objectKeyFor(caseType: EvidenceCaseType, caseId: string, itemId: string): string {
    return `evidence/${caseType}/${caseId}/${itemId}`;
  }

  /** Server-derived keys only: the key must embed this case and a fresh item id. */
  private itemIdFromObjectKey(
    caseType: EvidenceCaseType,
    caseId: string,
    objectKey: string
  ): string {
    const prefix = `evidence/${caseType}/${caseId}/`;
    if (!objectKey.startsWith(prefix)) {
      throw new BadRequestException(
        `objectKey '${objectKey}' was not issued for case '${caseType}:${caseId}' — ` +
          'call POST uploads first'
      );
    }
    const itemId = objectKey.slice(prefix.length);
    if (!/^evi-[0-9a-f-]{36}$/.test(itemId)) {
      throw new BadRequestException(`objectKey '${objectKey}' is not a server-issued evidence key`);
    }
    return itemId;
  }

  /**
   * Per-item integrity: the item's own payload hash plus its link position
   * inside the case chain (a prefix walk up to and including the item).
   */
  private async itemIntegrity(actor: User, item: EvidenceItem): Promise<'valid' | 'tampered'> {
    const caseItems = await this.items.listCaseItems(item.caseType, item.caseId);
    const index = caseItems.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) {
      return 'tampered'; // vanished between findById and the walk
    }
    const stored = caseItems[index];
    if (hashEvidenceItem(evidenceItemPayload(stored)) !== stored.itemHash) {
      await this.flagChainBreak(actor, item.caseType, item.caseId, {
        valid: false,
        checked: index,
        brokenAt: item.id,
        tamperedItemIds: [item.id]
      });
      return 'tampered';
    }
    const prefix = verifyEvidenceChain(caseItems.slice(0, index + 1));
    if (!prefix.valid) {
      await this.flagChainBreak(actor, item.caseType, item.caseId, prefix);
      return 'tampered';
    }
    return 'valid';
  }

  /** Tamper evidence: counter (must stay 0 — alert if not) + audit event. */
  private async flagChainBreak(
    actor: User,
    caseType: EvidenceCaseType,
    caseId: string,
    continuity: EvidenceChainVerification
  ): Promise<void> {
    this.telemetry.increment('evidence.chain_breaks_detected_total', 1, { case_type: caseType });
    await this.audit.record({
      actorId: actor.id,
      action: 'evidence.chain_break_detected',
      entityType: 'evidence_case',
      entityId: `${caseType}:${caseId}`,
      metadata: {
        caseType,
        caseId,
        brokenAt: continuity.brokenAt ?? null,
        checked: continuity.checked,
        tamperedItemIds: continuity.tamperedItemIds
      }
    });
  }
}
