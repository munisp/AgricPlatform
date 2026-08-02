import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, LivestockLot, User } from '@agric-platform/shared';
import { EXPORT_DOCUMENT_WATERMARK } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import { createInMemoryExportDocumentRepository } from '../../database/repositories/livestock-trade.repository.js';
import { ExportDocumentsService } from './export-documents.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const owner = asUser('farmer-1', ['farmer']);
const other = asUser('farmer-2', ['farmer']);
const admin = asUser('admin-1', ['admin']);

const animal: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: owner.id,
  state: 'Kaduna',
  lga: 'Zaria',
  status: 'alive',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const lot: LivestockLot = {
  id: 'LOT-AVI-KD-000001',
  species: 'chicken',
  quantity: 500,
  ownerUserId: owner.id,
  state: 'Kaduna',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

describe('ExportDocumentsService', () => {
  let documents: ReturnType<typeof createInMemoryExportDocumentRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let service: ExportDocumentsService;

  beforeEach(() => {
    documents = createInMemoryExportDocumentRepository();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    service = new ExportDocumentsService(
      audit as never,
      new DomainEventsService(outbox),
      createInMemoryAnimalRepository(createInMemoryOwnershipTransferRepository(), [animal]),
      createInMemoryLotRepository([lot]),
      documents
    );
  });

  it('generates a DRAFT certificate-of-origin payload from registry data', async () => {
    const doc = await service.generate(owner, {
      documentType: 'certificate_of_origin',
      subjectType: 'animal',
      subjectId: animal.id,
      destinationCountry: 'Ghana',
      hsCode: '0102'
    });
    expect(doc.status).toBe('draft');
    expect(doc.version).toBe(1);
    expect(doc.payload.watermark).toBe(EXPORT_DOCUMENT_WATERMARK);
    expect(doc.payload.consignment).toMatchObject({
      subjectId: animal.id,
      species: 'cattle',
      breed: 'White Fulani',
      quantity: 1,
      originState: 'Kaduna',
      originLga: 'Zaria',
      ownerUserId: owner.id
    });
    expect(doc.payload.certificateOfOrigin).toMatchObject({
      originCountry: 'Nigeria',
      exporterUserId: owner.id,
      destinationCountry: 'Ghana',
      hsCode: '0102'
    });
  });

  it('resolves consignment details for lots (quantity from the lot)', async () => {
    const doc = await service.generate(owner, {
      documentType: 'consignment_note',
      subjectType: 'lot',
      subjectId: lot.id
    });
    expect(doc.payload.consignment.quantity).toBe(500);
    expect(doc.payload.consignment.species).toBe('chicken');
  });

  it('carries sanitary certificate reference placeholders', async () => {
    const doc = await service.generate(owner, {
      documentType: 'sanitary_certificate',
      subjectType: 'animal',
      subjectId: animal.id,
      sanitaryCertificateRef: 'PENDING-AUTHORITY-ISSUANCE'
    });
    expect(doc.payload.sanitaryCertificateRef).toBe('PENDING-AUTHORITY-ISSUANCE');
    expect(doc.status).toBe('draft');
  });

  it('increments the version per (documentType, subject) on regeneration', async () => {
    const input = {
      documentType: 'certificate_of_origin' as const,
      subjectType: 'animal' as const,
      subjectId: animal.id
    };
    const first = await service.generate(owner, input);
    const second = await service.generate(owner, input);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.payload.version).toBe(2);
    const other1 = await service.generate(owner, { ...input, documentType: 'consignment_note' });
    expect(other1.version).toBe(1);
  });

  it('lists retained documents sorted by type and version', async () => {
    const input = {
      documentType: 'certificate_of_origin' as const,
      subjectType: 'animal' as const,
      subjectId: animal.id
    };
    await service.generate(owner, input);
    await service.generate(owner, input);
    const docs = await service.listForSubject(owner, 'animal', animal.id);
    expect(docs.map((doc) => doc.version)).toEqual([1, 2]);
  });

  it('gates generation and reads to the subject owner or admin', async () => {
    await expect(
      service.generate(other, {
        documentType: 'certificate_of_origin',
        subjectType: 'animal',
        subjectId: animal.id
      })
    ).rejects.toThrow('You may only access your own records');
    const doc = await service.generate(owner, {
      documentType: 'certificate_of_origin',
      subjectType: 'animal',
      subjectId: animal.id
    });
    await expect(service.getById(other, doc.id)).rejects.toThrow(
      'You may only access your own records'
    );
    await expect(service.getById(admin, doc.id)).resolves.toMatchObject({ id: doc.id });
  });

  it('publishes a domain event and audit record per document', async () => {
    await service.generate(owner, {
      documentType: 'certificate_of_origin',
      subjectType: 'animal',
      subjectId: animal.id
    });
    const events = await outbox.list();
    expect(events.map((event) => event.name)).toContain(
      'livestock_trade.export_document.generated'
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'livestock_trade.export_document_generated' })
    );
  });
});
