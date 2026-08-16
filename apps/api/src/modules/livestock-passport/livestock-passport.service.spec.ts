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
      vi.stubEnv('LIVESTOCK_PASSPORT_SECRET', 'spec-passport-signing-secret');
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

    it('is rejected on a suspended passport', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await service.suspend(regulator, document.passport.id);
      await expect(
        service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('confirmTransfer', () => {
    it('moves the animal and passport to the buyer through the core ownership ledger', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      const confirmed = await service.confirmTransfer(buyer, transfer.id);
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.executedTransferId).toBeDefined();
      expect((await animals.getById(ANIMAL.id)).ownerUserId).toBe(buyer.id);
      expect((await passports.getById(document.passport.id)).ownerUserId).toBe(buyer.id);
      // The executed row lives in the livestock core ownership ledger.
      const ledger = await ownershipTransfers.find({ animalId: ANIMAL.id });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].transferType).toBe('sale');
      // Both parties are in the hash chain (initiation by seller, confirmation by buyer).
      const { events, verification } = await service.getEvents(buyer, document.passport.id);
      expect(events.map((event) => event.type)).toEqual([
        'ISSUED',
        'TRANSFER_INITIATED',
        'TRANSFER_CONFIRMED'
      ]);
      expect(events[2].actorId).toBe(buyer.id);
      expect(verification.valid).toBe(true);
    });

    it('rejects confirmation by anyone but the named buyer', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await expect(service.confirmTransfer(farmer, transfer.id)).rejects.toThrow(ForbiddenException);
      await expect(service.confirmTransfer(stranger, transfer.id)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('rejects confirming a cancelled transfer', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await service.cancelTransfer(farmer, transfer.id);
      await expect(service.confirmTransfer(buyer, transfer.id)).rejects.toThrow(BadRequestException);
    });

    it('rejects a stale transfer when the seller no longer owns the animal', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await animals.update(ANIMAL.id, { ownerUserId: stranger.id });
      await expect(service.confirmTransfer(buyer, transfer.id)).rejects.toThrow(ConflictException);
    });

    it('re-checks the lien at confirmation time (lien registered after initiation still blocks)', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await liens.create(ACTIVE_LIEN);
      await expect(service.confirmTransfer(buyer, transfer.id)).rejects.toThrow(ConflictException);
      expect((await animals.getById(ANIMAL.id)).ownerUserId).toBe(farmer.id);
    });
  });

  describe('cancelTransfer', () => {
    it('lets the seller cancel and records it in the chain', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      const cancelled = await service.cancelTransfer(farmer, transfer.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancelledAt).toBeDefined();
      const { events } = await service.getEvents(farmer, document.passport.id);
      expect(events.map((event) => event.type)).toEqual([
        'ISSUED',
        'TRANSFER_INITIATED',
        'TRANSFER_CANCELLED'
      ]);
    });

    it('rejects cancellation by the buyer or a stranger', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const transfer = await service.initiateTransfer(farmer, document.passport.id, {
        toUserId: buyer.id
      });
      await expect(service.cancelTransfer(buyer, transfer.id)).rejects.toThrow(ForbiddenException);
      await expect(service.cancelTransfer(stranger, transfer.id)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('lists incoming and outgoing transfers for the counterparties', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await service.initiateTransfer(farmer, document.passport.id, { toUserId: buyer.id });
      expect(await service.listMyTransfers(farmer, 'outgoing')).toHaveLength(1);
      expect(await service.listMyTransfers(buyer, 'incoming')).toHaveLength(1);
      expect(await service.listMyTransfers(buyer, 'outgoing')).toHaveLength(0);
    });
  });

  /* ------------------------- public verification ------------------------- */

  describe('verifyPublic (QR flow)', () => {
    it('verifies the code, redacts owner PII to initials and flags encumbrance honestly', async () => {
      seed({ lien: ACTIVE_LIEN });
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const view = await service.verifyPublic(document.passport.passportCode);
      expect(view.verified).toBe(true);
      expect(view.ownerInitials).toBe('A.B.');
      expect(JSON.stringify(view)).not.toContain(farmer.fullName);
      expect(view.encumbrance.activeLien).toBe(true);
      expect(view.encumbrance.insured).toBe(false);
      expect(view.tagCheck).toEqual({ basis: 'stub', stub: true });
      expect(view.chain.valid).toBe(true);
      expect(view.qr.verifyPath).toContain(encodeURIComponent(document.passport.passportCode));
      expect(view.disclaimers.join(' ')).toContain('STUB');
      expect(JSON.stringify(view)).not.toContain('30,000');
    });

    it('answers 404 for forged, malformed or unknown codes (no oracle)', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const code = document.passport.passportCode;
      const forgedAnimal = code.replace('NG-BOV-KD-000123', 'NG-BOV-KD-000124');
      const forgedSig = `${code.slice(0, -2)}ff`;
      for (const bad of ['', 'LSP.x', 'garbage', forgedAnimal, forgedSig]) {
        await expect(service.verifyPublic(bad)).rejects.toThrow(NotFoundException);
      }
    });
  });

  /* ------------------------- oversight & lifecycle ----------------------- */

  describe('oversight and lifecycle', () => {
    it('regulator export aggregates every passport with chain validity', async () => {
      seed({ lien: ACTIVE_LIEN });
      await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const rows = await service.oversightExport(regulator);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        animalId: ANIMAL.id,
        species: 'cattle',
        tagCheckBasis: 'stub',
        activeLien: true,
        chainValid: true,
        eventCount: 1
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'livestock_passport.oversight_exported' })
      );
    });

    it('rejects oversight export for farmers', async () => {
      await expect(service.oversightExport(farmer)).rejects.toThrow(ForbiddenException);
    });

    it('suspend and reinstate walk the lifecycle with chain events', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      const suspended = await service.suspend(regulator, document.passport.id);
      expect(suspended.status).toBe('suspended');
      const reinstated = await service.reinstate(admin, document.passport.id);
      expect(reinstated.status).toBe('active');
      const { events, verification } = await service.getEvents(farmer, document.passport.id);
      expect(events.map((event) => event.type)).toEqual(['ISSUED', 'SUSPENDED', 'REINSTATED']);
      expect(verification.valid).toBe(true);
    });

    it('rejects lifecycle changes from non-privileged callers and invalid transitions', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await expect(service.suspend(farmer, document.passport.id)).rejects.toThrow(ForbiddenException);
      await expect(service.reinstate(regulator, document.passport.id)).rejects.toThrow(
        BadRequestException
      );
      await expect(service.suspend(regulator, document.passport.id)).resolves.toBeDefined();
      await expect(service.suspend(regulator, document.passport.id)).rejects.toThrow(
        BadRequestException
      );
    });

    it('revoked is terminal (suspend of a revoked passport is impossible)', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await passports.update(document.passport.id, { status: 'revoked' });
      await expect(service.suspend(regulator, document.passport.id)).rejects.toThrow(
        BadRequestException
      );
    });

    it('authorityStatus surfaces the honest stub posture', async () => {
      const status = await service.authorityStatus(farmer);
      expect(status.driver).toBe('stub');
      expect(status.notes.join(' ')).toContain('Stub');
    });
  });

  /* ------------------------------ tamper evidence ------------------------ */

  describe('hash chain tamper evidence', () => {
    it('detects a mutated event payload', async () => {
      const document = await service.issuePassport(farmer, { animalId: ANIMAL.id });
      await service.suspend(regulator, document.passport.id);
      const stored = await passportEvents.listByPassport(document.passport.id);
      const tampered = { ...stored[0], payload: { ...stored[0].payload, species: 'poultry' } };
      const { verifyPassportChain } = await import('./passport.types.js');
      expect(verifyPassportChain(document.passport.id, [tampered, stored[1]]).valid).toBe(false);
      expect(verifyPassportChain(document.passport.id, stored).valid).toBe(true);
    });
  });
});

describe('initialsOf', () => {
  it('redacts names to initials', () => {
    expect(initialsOf('Adamu Bello')).toBe('A.B.');
    expect(initialsOf('Chidinma')).toBe('C.');
    expect(initialsOf('  Mary  Jane  Watson ')).toBe('M.J.W.');
    expect(initialsOf('')).toBe('—');
  });
});
