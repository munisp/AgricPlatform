import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { newId } from '../../../common/async-repository.js';
import {
  IMPORT_BATCH_REPOSITORY,
  IMPORT_RECORD_REPOSITORY,
  USER_REPOSITORY
} from '../../../database/persistence.tokens.js';
import type {
  ImportBatch,
  ImportBatchRepository,
  ImportRecord,
  ImportRecordRepository
} from '../../../database/repositories/phase3.repository.js';
import type { UserRepository } from '../../../database/repositories/user.repository.js';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import {
  createFieldDataSources,
  type BeneficiarySubmission,
  type FieldDataSource
} from '../drivers/field-data.clients.js';
import { normaliseNin, normalisePhone, sha256 } from './phase3.utils.js';

/** One raw beneficiary row supplied by an admin upload or a field-data pull. */
export interface BeneficiaryRowInput {
  nin?: string;
  phone?: string;
  /** Donor-attested consent capture date (ISO-8601, required). */
  consentDate: string;
  /** Remaining donor fields carried through for the admin review window. */
  attributes?: Record<string, unknown>;
}

export interface CreateBatchInput {
  /** odk | kobo | csv_upload */
  sourceSystem: string;
  donorSource: string;
  records: BeneficiaryRowInput[];
}

export interface ConfirmResult {
  batch: ImportBatch;
  merged: number;
  rejected: number;
}

/**
 * ODK / KoboToolbox NGO beneficiary import (wave P5a). Rows are validated,
 * identity-minimised (SHA-256 hashes only) and staged with donor source +
 * consent date; phone/NIN hashes deduplicate within the batch and against
 * identity.users. Nothing touches member accounts until an admin confirms
 * the batch, at which point staged records flip to MERGED and a domain
 * event carries the outcome (provisioning is a downstream concern).
 */
@Injectable()
export class BeneficiaryImportService {
  constructor(
    @Inject(IMPORT_BATCH_REPOSITORY) private readonly batches: ImportBatchRepository,
    @Inject(IMPORT_RECORD_REPOSITORY) private readonly records: ImportRecordRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly events: DomainEventsService,
    @Optional() private readonly sources: FieldDataSource[] = createFieldDataSources()
  ) {}

  /** Hashes of every platform user's normalised phone (dedupe target). */
  private async platformPhoneHashes(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const user of await this.users.all()) {
      const digits = normalisePhone(user.phone);
      if (digits) {
        hashes.set(sha256(digits), user.id);
      }
    }
    return hashes;
  }

  /**
   * Stages a batch: validates rows, hashes identity fields, dedupes and
   * persists. Rows failing validation or duplicating an earlier row in the
   * same batch are stored REJECTED with the reason in the payload.
   */
  async createBatch(input: CreateBatchInput, actorId: string): Promise<ImportBatch> {
    if (!input.sourceSystem?.trim() || !input.donorSource?.trim()) {
      throw new BadRequestException('sourceSystem and donorSource are required');
    }
    if (!Array.isArray(input.records) || input.records.length === 0) {
      throw new BadRequestException('records must be a non-empty array');
    }
    const batch: ImportBatch = {
      id: newId('batch'),
      sourceSystem: input.sourceSystem.trim(),
      donorSource: input.donorSource.trim(),
      status: 'STAGED',
      recordCount: input.records.length,
      createdBy: actorId,
      createdAt: new Date().toISOString()
    };
    await this.batches.create(batch);

    const platformPhones = await this.platformPhoneHashes();
    const seenPhoneHashes = new Set<string>();
    const seenNinHashes = new Set<string>();
    const now = new Date().toISOString();

    for (const row of input.records) {
      const staged = this.stageRow(batch, row, platformPhones, seenPhoneHashes, seenNinHashes, now);
      await this.records.create(staged);
    }
    await this.events.publish('integrations.beneficiary_import.staged', {
      batchId: batch.id,
      sourceSystem: batch.sourceSystem,
      recordCount: batch.recordCount
    }, actorId);
    return batch;
  }

  private stageRow(
    batch: ImportBatch,
    row: BeneficiaryRowInput,
    platformPhones: Map<string, string>,
    seenPhoneHashes: Set<string>,
    seenNinHashes: Set<string>,
    now: string
  ): ImportRecord {
    const base: ImportRecord = {
      id: newId('irec'),
      batchId: batch.id,
      payload: { ...(row.attributes ?? {}) },
      status: 'STAGED',
      donorSource: batch.donorSource,
      consentDate: '',
      createdAt: now
    };
    const reject = (reason: string): ImportRecord => ({
      ...base,
      status: 'REJECTED',
      consentDate: Number.isNaN(new Date(row.consentDate).getTime())
        ? now
        : new Date(row.consentDate).toISOString(),
      payload: { ...base.payload, rejectionReason: reason }
    });

    const consentDate = new Date(row.consentDate);
    if (!row.consentDate || Number.isNaN(consentDate.getTime())) {
      return reject('missing or invalid consentDate');
    }
    base.consentDate = consentDate.toISOString();
    const digits = row.phone ? normalisePhone(row.phone) : '';
    const nin = row.nin ? normaliseNin(row.nin) : '';
    if (!digits && !nin) {
      return reject('row needs at least one of phone or nin');
    }
    if (digits) {
      base.phoneHash = sha256(digits);
    }
    if (nin) {
      base.ninHash = sha256(nin);
    }
    // Within-batch dedupe.
    if (
      (base.phoneHash && seenPhoneHashes.has(base.phoneHash)) ||
      (base.ninHash && seenNinHashes.has(base.ninHash))
    ) {
      return reject('duplicate of an earlier row in this batch');
    }
    if (base.phoneHash) {
      seenPhoneHashes.add(base.phoneHash);
    }
    if (base.ninHash) {
      seenNinHashes.add(base.ninHash);
    }
    // Dedupe against identity.users (phone is the stored identity key).
    const matchedUserId = base.phoneHash ? platformPhones.get(base.phoneHash) : undefined;
    if (matchedUserId) {
      base.matchedUserId = matchedUserId;
      base.payload = { ...base.payload, matchNote: 'matches existing platform user' };
    }
    return base;
  }

  async getBatch(id: string): Promise<ImportBatch> {
    return this.batches.getById(id);
  }

  async recordsFor(batchId: string, status?: ImportRecord['status']): Promise<ImportRecord[]> {
    return this.records.find({ batchId, ...(status ? { status } : {}) });
  }

  /**
   * Admin confirm-before-merge: flips STAGED records to MERGED and closes
   * the batch. REJECTED rows stay rejected. Confirming a confirmed batch is
   * a conflict (no silent re-merge).
   */
  async confirmBatch(batchId: string, actorId: string): Promise<ConfirmResult> {
    const batch = await this.batches.getById(batchId);
    if (batch.status === 'CONFIRMED') {
      throw new ConflictException('This import batch has already been confirmed');
    }
    const staged = await this.records.find({ batchId, status: 'STAGED' });
    for (const record of staged) {
      await this.records.update(record.id, { status: 'MERGED' });
    }
    const rejected = await this.records.count({ batchId, status: 'REJECTED' });
    const confirmed = await this.batches.update(batchId, {
      status: 'CONFIRMED',
      confirmedAt: new Date().toISOString(),
      confirmedBy: actorId
    });
    await this.events.publish('integrations.beneficiary_import.confirmed', {
      batchId,
      merged: staged.length,
      rejected,
      matchedUsers: staged.filter((record) => record.matchedUserId).length
    }, actorId);
    return { batch: confirmed, merged: staged.length, rejected };
  }

  /**
   * SFTP/API pull scaffold: fetches submissions from each configured
   * field-data source and stages them as batches. Returns the created batch
   * ids; inert (no sources) while FIELD_DATA_DRIVER is stub.
   */
  async pullFromSources(donorSource: string, actorId: string): Promise<string[]> {
    const batchIds: string[] = [];
    for (const source of this.sources) {
      const submissions = await source.fetchSubmissions();
      if (submissions.length === 0) {
        continue;
      }
      const batch = await this.createBatch(
        {
          sourceSystem: source.name,
          donorSource,
          records: submissions.map((submission) => submissionToRow(submission))
        },
        actorId
      );
      batchIds.push(batch.id);
    }
    return batchIds;
  }
}

/** Maps a raw field-data submission onto the import row contract. */
export function submissionToRow(submission: BeneficiarySubmission): BeneficiaryRowInput {
  const stringField = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = submission[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return undefined;
  };
  const knownKeys = new Set(['nin', 'NIN', 'phone', 'phone_number', 'consent_date', 'consentDate']);
  const attributes = Object.fromEntries(
    Object.entries(submission).filter(([key]) => !knownKeys.has(key))
  );
  return {
    nin: stringField('nin', 'NIN'),
    phone: stringField('phone', 'phone_number'),
    consentDate: stringField('consent_date', 'consentDate') ?? '',
    attributes
  };
}
