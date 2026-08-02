import { Inject, Injectable } from '@nestjs/common';
import type {
  ExportDocument,
  ExportDocumentPayload,
  ExportDocumentType,
  LivestockSubjectType,
  User
} from '@agric-platform/shared';
import { EXPORT_DOCUMENT_WATERMARK } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  EXPORT_DOCUMENT_REPOSITORY,
  LOT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  LotRepository
} from '../../database/repositories/livestock.repository.js';
import type { ExportDocumentRepository } from '../../database/repositories/livestock-trade.repository.js';
import { requireActor, resolveSubject } from './trade.utils.js';

export interface GenerateExportDocumentInput {
  documentType: ExportDocumentType;
  subjectType: LivestockSubjectType;
  subjectId: string;
  destinationCountry?: string;
  hsCode?: string;
  /** Placeholder until a sanitary-certificate authority integrates. */
  sanitaryCertificateRef?: string;
}

/**
 * AfCFTA / cross-border export documents (F4). Generates structured JSON
 * payloads (certificate-of-origin fields, sanitary certificate reference
 * placeholders, consignment details resolved from the registry) ready for
 * PDF rendering. Every document is a retained DRAFT — nothing is submitted
 * to any authority — and regenerating for the same subject increments the
 * version number.
 */
@Injectable()
export class ExportDocumentsService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(EXPORT_DOCUMENT_REPOSITORY)
    private readonly documents: ExportDocumentRepository
  ) {}

  async generate(actor: User | null, input: GenerateExportDocumentInput): Promise<ExportDocument> {
    const caller = requireActor(actor);
    const subject = await resolveSubject(this.animals, this.lots, input.subjectType, input.subjectId);
    assertSelfOrAdmin(caller, subject.ownerUserId);
    const version = await this.documents.nextVersion(
      input.documentType,
      input.subjectType,
      input.subjectId
    );
    const now = new Date().toISOString();
    const payload: ExportDocumentPayload = {
      watermark: EXPORT_DOCUMENT_WATERMARK,
      documentType: input.documentType,
      version,
      consignment: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        species: subject.species,
        breed: subject.breed,
        quantity: subject.quantity ?? 1,
        originState: subject.state,
        originLga: subject.lga,
        ownerUserId: subject.ownerUserId
      },
      certificateOfOrigin: {
        originCountry: 'Nigeria',
        exporterUserId: subject.ownerUserId,
        destinationCountry: input.destinationCountry,
        hsCode: input.hsCode
      },
      sanitaryCertificateRef: input.sanitaryCertificateRef,
      generatedAt: now
    };
    const document: ExportDocument = {
      id: newId('export_document'),
      documentType: input.documentType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      version,
      status: 'draft',
      payload,
      createdByUserId: caller.id,
      createdAt: now
    };
    const created = await this.documents.create(document);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.export_document_generated',
      entityType: 'export_document',
      entityId: created.id,
      metadata: { documentType: input.documentType, subjectId: input.subjectId, version }
    });
    await this.events.publish(
      'livestock_trade.export_document.generated',
      {
        documentId: created.id,
        documentType: input.documentType,
        subjectId: input.subjectId,
        version
      },
      caller.id
    );
    return created;
  }

  async listForSubject(
    actor: User | null,
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<ExportDocument[]> {
    const subject = await resolveSubject(this.animals, this.lots, subjectType, subjectId);
    assertSelfOrAdmin(actor, subject.ownerUserId);
    const documents = await this.documents.find({ subjectType, subjectId });
    return documents.sort(
      (a, b) => a.documentType.localeCompare(b.documentType) || a.version - b.version
    );
  }

  async getById(actor: User | null, id: string): Promise<ExportDocument> {
    const document = await this.documents.getById(id);
    assertSelfOrAdmin(actor, document.createdByUserId);
    return document;
  }
}
