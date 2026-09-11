import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, AnimalHealthRecord, LivestockLien, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryOwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import {
  createInMemoryHealthRecordRepository,
  createInMemoryMovementPermitRepository,
  createInMemoryMovementRepository
} from '../../database/repositories/livestock-health.repository.js';
import {
  createInMemoryInsurancePolicyRepository,
  createInMemoryLienRepository
} from '../../database/repositories/livestock-trade.repository.js';
import {
  createInMemoryLivestockPassportRepository,
  createInMemoryPassportEventRepository,
  createInMemoryPassportTransferRepository
} from '../../database/repositories/livestock-passport.repository.js';
import { StubAnimalIdAuthorityProvider } from './animal-id-authority.provider.js';
import { initialsOf, LivestockPassportService } from './livestock-passport.service.js';

type UserRef = Pick<User, 'id' | 'roles'> & { fullName?: string };
const asUser = (ref: UserRef): User => ({
  phone: '+2348000000000',
  fullName: ref.fullName ?? 'Spec User',
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...ref
});

const farmer = asUser({ id: 'farmer-1', roles: ['farmer'], fullName: 'Adamu Bello' });
const buyer = asUser({ id: 'buyer-1', roles: ['buyer'], fullName: 'Chidinma Okafor' });
const vet = asUser({ id: 'vet-1', roles: ['vet'] });
const regulator = asUser({ id: 'regulator-1', roles: ['regulator'] });
const admin = asUser({ id: 'admin-1', roles: ['admin'] });
const stranger = asUser({ id: 'farmer-2', roles: ['farmer'] });

const ANIMAL: Animal = {
  id: 'NG-BOV-KD-000123',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  birthDate: '2022-03-15',
  tagId: 'TAG-KD-0412',
  ownerUserId: farmer.id,
  state: 'Kaduna',
  lga: 'Zaria',
  status: 'alive',
  createdAt: '2026-05-02T08:00:00.000Z',
  updatedAt: '2026-05-02T08:00:00.000Z'
};

const VACCINATION: AnimalHealthRecord = {
  id: 'hr-1',
  animalId: ANIMAL.id,
  recordType: 'vaccination',
  product: 'FMD',
  batchNumber: 'B-2026-01',
  dose: '2 ml',
  administeredAt: '2026-06-01T09:00:00.000Z',
  vetUserId: vet.id,
  signature: 'c2ln',
  signedAt: '2026-06-01T09:00:00.000Z',
  createdAt: '2026-06-01T09:00:00.000Z'
};

const ACTIVE_LIEN: LivestockLien = {
  id: 'lien-1',
  subjectType: 'animal',
  subjectId: ANIMAL.id,
  lenderUserId: 'lender-1',
  borrowerUserId: farmer.id,
  principalKobo: 30_000_000,
  terms: '6-month input credit.',
  status: 'active',
  registeredAt: '2026-06-05T09:00:00.000Z',
  createdAt: '2026-06-05T09:00:00.000Z',
  updatedAt: '2026-06-05T09:00:00.000Z'
};

describe('LivestockPassportService', () => {
  let ownershipTransfers: ReturnType<typeof createInMemoryOwnershipTransferRepository>;
  let animals: ReturnType<typeof createInMemoryAnimalRepository>;
  let healthRecords: ReturnType<typeof createInMemoryHealthRecordRepository>;
  let movements: ReturnType<typeof createInMemoryMovementRepository>;
  let permits: ReturnType<typeof createInMemoryMovementPermitRepository>;
  let liens: ReturnType<typeof createInMemoryLienRepository>;
  let policies: ReturnType<typeof createInMemoryInsurancePolicyRepository>;
  let passports: ReturnType<typeof createInMemoryLivestockPassportRepository>;
  let passportEvents: ReturnType<typeof createInMemoryPassportEventRepository>;
  let passportTransfers: ReturnType<typeof createInMemoryPassportTransferRepository>;
  let users: { getById: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let authority: StubAnimalIdAuthorityProvider;
  let service: LivestockPassportService;

  const seed = (options: { lien?: LivestockLien; health?: AnimalHealthRecord[] } = {}) => {
    ownershipTransfers = createInMemoryOwnershipTransferRepository();
    animals = createInMemoryAnimalRepository(ownershipTransfers, [structuredClone(ANIMAL)]);
    healthRecords = createInMemoryHealthRecordRepository(options.health ?? [VACCINATION]);
    movements = createInMemoryMovementRepository();
    permits = createInMemoryMovementPermitRepository();
    liens = createInMemoryLienRepository(options.lien ? [options.lien] : []);
    policies = createInMemoryInsurancePolicyRepository();
    passports = createInMemoryLivestockPassportRepository();
    passportEvents = createInMemoryPassportEventRepository();
    passportTransfers = createInMemoryPassportTransferRepository();
    users = {
      getById: vi.fn().mockImplementation(async (id: string) => {
        const known = [farmer, buyer, vet, regulator, admin, stranger].find((u) => u.id === id);
        if (!known) {
          throw new NotFoundException(`User '${id}' not found`);
        }
        return known;
      })
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    authority = new StubAnimalIdAuthorityProvider();
    service = new LivestockPassportService(
      users as never,
      audit as never,
      new DomainEventsService(createInMemoryOutboxRepository()),
      authority,
      animals,
      ownershipTransfers,
      healthRecords,
      movements,
      permits,
      liens,
      policies,
      passports,
      passportEvents,
      passportTransfers
    );
  };

  beforeEach(() => seed());

  afterEach(() => vi.unstubAllEnvs());

  /* ------------------------------ issuance ------------------------------ */

  describe('issuePassport', () => {
    it('issues a passport with an HMAC-signed code and the genesis chain event', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      expect(document.passport.animalId).toBe(ANIMAL.id);
      expect(document.passport.ownerUserId).toBe(farmer.id);
      expect(document.passport.passportCode).toMatch(/^LSP\.NG-BOV-KD-000123\.[0-9a-f]{8}\.[0-9a-f]{16}$/);
      expect(document.passport.tagCheckBasis).toBe('stub'); // tagged animal → authority port (stub default)
      expect(document.chain.valid).toBe(true);
      expect(document.chain.eventCount).toBe(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'livestock_passport.passport_issued', actorId: farmer.id })
      );
    });

    it('aggregates existing health records into the vaccination summary', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      expect(document.vaccinationSummary.requiredVaccinations).toEqual(['FMD', 'CBPP', 'Anthrax']);
      expect(document.vaccinationSummary.completedVaccinations).toEqual(['FMD']);
      expect(document.vaccinationSummary.coverage).toBeCloseTo(1 / 3);
      expect(document.healthRecords).toHaveLength(1);
    });

    it('records tagCheckBasis none when the animal carries no tag or eid', async () => {
      seed();
      await animals.update(ANIMAL.id, { tagId: undefined });
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      expect(document.passport.tagCheckBasis).toBe('none');
    });

    it('rejects unauthenticated issuance', async () => {
      await expect(service.issuePassport(null, { animalId: ANIMAL.id })).rejects.toThrow(
        UnauthorizedException
      );
    });

    it('rejects issuance by a non-owner', async () => {
      await expect(service.issuePassport(stranger, { animalId: ANIMAL.id })).rejects.toThrow(
        ForbiddenException
      );
    });

    it('allows admin issuance for programme tooling', async () => {
      const document = await service.issuePassport(admin, { animalId: ANIMAL.id });
      expect(document.passport.issuedBy).toBe(admin.id);
    });

    it('rejects a second passport for the same animal (one passport per animal)', async () => {
      await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await expect(service.issuePassport(farmer, { animalId: ANIMAL.id })).rejects.toThrow(
        ConflictException
      );
    });

    it('fails closed with 503 when a configured live authority is unreachable', async () => {
      seed();
      const failingAuthority = {
        name: 'http' as const,
        checkTag: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
        status: vi.fn()
      };
      service = new LivestockPassportService(
        users as never,
        audit as never,
        new DomainEventsService(createInMemoryOutboxRepository()),
        failingAuthority,
        animals,
        ownershipTransfers,
        healthRecords,
        movements,
        permits,
        liens,
        policies,
        passports,
        passportEvents,
        passportTransfers
      );
      await expect(service.issuePassport(farmer, { animalId: ANIMAL.id })).rejects.toThrow(
        ServiceUnavailableException
      );
      expect(await passports.findByAnimalId(ANIMAL.id)).toBeUndefined();
    });

    it('refuses stub-basis tag checks for issuance in production (fail closed)', async () => {
      // The stub authority verdict is a deterministic fabrication — stamping
      // it on a passport in production would certify identity against no real
      // registry. Issuance must refuse with 503 and persist nothing.
      vi.stubEnv('NODE_ENV', 'production');
      await expect(service.issuePassport(farmer, { animalId: ANIMAL.id })).rejects.toThrow(
        ServiceUnavailableException
      );
      expect(await passports.findByAnimalId(ANIMAL.id)).toBeUndefined();
    });

    it('issues in production when the authority check is live-basis', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('LIVESTOCK_PASSPORT_SECRET', 'spec-passport-signing-secret-32ch');
      const liveAuthority = {
        name: 'http' as const,
        checkTag: vi.fn().mockResolvedValue({
          registered: true,
          registryReference: 'NAIS-LIVE-1',
          basis: 'live',
          detail: 'live registry hit'
        }),
        status: vi.fn()
      };
      service = new LivestockPassportService(
        users as never,
        audit as never,
        new DomainEventsService(createInMemoryOutboxRepository()),
        liveAuthority,
        animals,
        ownershipTransfers,
        healthRecords,
        movements,
        permits,
        liens,
        policies,
        passports,
        passportEvents,
        passportTransfers
      );
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      expect(document.passport.tagCheckBasis).toBe('live');
    });
  });

  /* ------------------------------- reads -------------------------------- */

  describe('read access', () => {
    it('lists only the caller’s own passports', async () => {
      await service.issuePassport(farmer, { animalId: ANIMAL.id });
      expect(await service.listMine(farmer)).toHaveLength(1);
      expect(await service.listMine(stranger)).toHaveLength(0);
    });

    it('lets the owner, vets and regulators read the full document but not strangers', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await expect(service.getPassport(farmer, document.passport.id)).resolves.toBeDefined();
      await expect(service.getPassport(vet, document.passport.id)).resolves.toBeDefined();
      await expect(service.getPassport(regulator, document.passport.id)).resolves.toBeDefined();
      await expect(service.getPassport(stranger, document.passport.id)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('lets the buyer named on a pending transfer read the document', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id });
      const read = await service.getPassport(buyer, document.passport.id);
      expect(read.passport.id).toBe(document.passport.id);
    });

    it('returns the hash chain with recomputed verification', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const { events, verification } = await service.getEvents(farmer, document.passport.id);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ISSUED');
      expect(verification.valid).toBe(true);
    });
  });

  /* --------------------------- ownership transfer ------------------------ */

  describe('initiateTransfer', () => {
    it('creates a pending transfer with a chain event and audit', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      expect(transfer.status).toBe('pending');
      expect(transfer.fromUserId).toBe(farmer.id);
      expect(transfer.toUserId).toBe(buyer.id);
      const { events } = await service.getEvents(farmer, document.passport.id);
      expect(events.map((event) => event.type)).toEqual(['ISSUED', 'TRANSFER_INITIATED']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'livestock_passport.transfer_initiated' })
      );
    });

    it('is blocked while an active lien exists on the animal', async () => {
      seed({ lien: ACTIVE_LIEN });
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id })
      ).rejects.toThrow(ConflictException);
    });

    it('is rejected for non-owners, self-transfers, unknown buyers and dead animals', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await expect(
        service.initiateTransfer(stranger, document.passport.id, { toUserId: buyer.id })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: farmer.id })
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: 'ghost' })
      ).rejects.toThrow(NotFoundException);
      await animals.update(ANIMAL.id, { status: 'dead' });
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id })
      ).rejects.toThrow(BadRequestException);
    });

    it('allows only one pending transfer per passport', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id });
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: admin.id })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('confirmTransfer', () => {
    it('executes the ownership change through the livestock core ledger', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      const confirmed = await service.confirmTransfer(buyer, transfer.id);
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.executedTransferId).toBeDefined();
      expect((await animals.getById(ANIMAL.id)).ownerUserId).toBe(buyer.id);
      expect((await passports.getById(document.passport.id)).ownerUserId).toBe(buyer.id);
      const ledger = await ownershipTransfers.find({ animalId: ANIMAL.id });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].fromUserId).toBe(farmer.id);
      expect(ledger[0].toUserId).toBe(buyer.id);
      const { events } = await service.getEvents(buyer, document.passport.id);
      expect(events.map((event) => event.type)).toEqual([
        'ISSUED',
        'TRANSFER_INITIATED',
        'TRANSFER_CONFIRMED'
      ]);
    });

    it('keeps both parties in the audit trail (seller initiated, buyer confirmed)', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await service.confirmTransfer(buyer, transfer.id);
      const actions = audit.record.mock.calls.map((call) => call[0]);
      expect(actions).toContainEqual(
        expect.objectContaining({ action: 'livestock_passport.transfer_initiated', actorId: farmer.id })
      );
      expect(actions).toContainEqual(
        expect.objectContaining({
          action: 'livestock_passport.transfer_confirmed',
          actorId: buyer.id,
          metadata: expect.objectContaining({ fromUserId: farmer.id, toUserId: buyer.id })
        })
      );
    });

    it('rejects confirmation by anyone but the named buyer', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await expect(service.confirmTransfer(stranger, transfer.id)).rejects.toThrow(
        ForbiddenException
      );
      await expect(service.confirmTransfer(farmer, transfer.id)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('re-checks the lien guard at confirmation time', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await liens.create({ ...ACTIVE_LIEN, id: 'lien-late' });
      await expect(service.confirmTransfer(buyer, transfer.id)).rejects.toThrow(ConflictException);
    });

    it('rejects a stale transfer when the animal already changed hands', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await animals.update(ANIMAL.id, { ownerUserId: stranger.id });
      await expect(service.confirmTransfer(buyer, transfer.id)).rejects.toThrow(ConflictException);
    });
  });

  describe('cancelTransfer', () => {
    it('lets the seller or an admin cancel, but not the buyer', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const first = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await expect(service.cancelTransfer(buyer, first.id)).rejects.toThrow(ForbiddenException);
      const cancelled = await service.cancelTransfer(farmer, first.id);
      expect(cancelled.status).toBe('cancelled');
      // A fresh transfer can be initiated after cancellation.
      const second = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      const adminCancelled = await service.cancelTransfer(admin, second.id);
      expect(adminCancelled.status).toBe('cancelled');
    });

    it('lists incoming transfers for the buyer and outgoing for the seller', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id });
      expect(await service.listMyTransfers(buyer, 'incoming')).toHaveLength(1);
      expect(await service.listMyTransfers(buyer, 'outgoing')).toHaveLength(0);
      expect(await service.listMyTransfers(farmer, 'outgoing')).toHaveLength(1);
    });
  });

  /* ------------------------- public verification ------------------------- */

  describe('verifyPublic (unauthenticated, redacted)', () => {
    it('verifies the genuine code and returns the redacted view', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const view = await service.verifyPublic(document.passport.passportCode);
      expect(view.verified).toBe(true);
      expect(view.animal.id).toBe(ANIMAL.id);
      expect(view.animal.species).toBe('cattle');
      expect(view.ownerInitials).toBe('A.B.');
      expect(JSON.stringify(view)).not.toContain('Adamu');
      expect(JSON.stringify(view)).not.toContain(farmer.id);
      expect(view.vaccinationSummary.completedVaccinations).toEqual(['FMD']);
      expect(view.movementLegality).toEqual({
        totalMovements: 0,
        movementsWithPermit: 0,
        legal: true
      });
      expect(view.encumbrance).toEqual({ activeLien: false, insured: false });
      expect(view.tagCheck).toEqual({ basis: 'stub', stub: true });
      expect(view.chain).toMatchObject({ eventCount: 1, valid: true });
      expect(view.qr.code).toBe(document.passport.passportCode);
      expect(view.qr.verifyPath).toContain('/livestock-passport/verify/');
    });

    it('flags an active lien without exposing amounts or lender identity', async () => {
      seed({ lien: ACTIVE_LIEN });
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const view = await service.verifyPublic(document.passport.passportCode);
      expect(view.encumbrance.activeLien).toBe(true);
      expect(JSON.stringify(view)).not.toContain('30000000');
      expect(JSON.stringify(view)).not.toContain('lender-1');
    });

    it('rejects forged, tampered and malformed codes with a plain 404', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const code = document.passport.passportCode;
      await expect(service.verifyPublic('not-a-code')).rejects.toThrow(NotFoundException);
      // Forged: valid shape, wrong signature tail.
      await expect(
        service.verifyPublic(`${code.slice(0, -4)}ffff`)
      ).rejects.toThrow(NotFoundException);
      // Replayed nonce against a different animal id.
      const replayed = code.replace(ANIMAL.id, 'NG-CAP-KD-000009');
      await expect(service.verifyPublic(replayed)).rejects.toThrow(NotFoundException);
    });
  });

  /* ------------------------- oversight & lifecycle ----------------------- */

  describe('oversight export + status lifecycle', () => {
    it('exports aggregate rows to regulators, never to farmers', async () => {
      await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const rows = await service.oversightExport(regulator);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        animalId: ANIMAL.id,
        ownerUserId: farmer.id,
        status: 'active',
        chainValid: true,
        eventCount: 1,
        activeLien: false,
        pendingTransfer: false
      });
      await expect(service.oversightExport(farmer)).rejects.toThrow(ForbiddenException);
    });

    it('suspension locks transfers and reinstatement restores them (regulator/admin only)', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await expect(service.suspend(farmer, document.passport.id)).rejects.toThrow(
        ForbiddenException
      );
      const suspended = await service.suspend(regulator, document.passport.id);
      expect(suspended.status).toBe('suspended');
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id })
      ).rejects.toThrow(BadRequestException);
      await service.reinstate(admin, document.passport.id);
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      expect(transfer.status).toBe('pending');
      const { events } = await service.getEvents(farmer, document.passport.id);
      expect(events.map((event) => event.type)).toEqual([
        'ISSUED',
        'SUSPENDED',
        'REINSTATED',
        'TRANSFER_INITIATED'
      ]);
    });

    it('reports the authority port status honestly', async () => {
      const status = await service.authorityStatus(admin);
      expect(status.detail).toContain('Stub provider');
    });
  });
});

describe('initialsOf', () => {
  it('redacts names to initials', () => {
    expect(initialsOf('Adamu Bello')).toBe('A.B.');
    expect(initialsOf('chidinma')).toBe('C.');
    expect(initialsOf('  ')).toBe('—');
    expect(initialsOf('Ngozi Ada Eze')).toBe('N.A.E.');
  });
});
