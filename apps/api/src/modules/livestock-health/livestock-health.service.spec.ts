import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Animal,
  AnimalMovement,
  LivestockLot,
  User,
  VaccinationDueItem
} from '@agric-platform/shared';
import { DEV_VET_SIGNING_SECRET } from '../../config/livestock-health.config.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository
} from '../../database/repositories/livestock.repository.js';
import {
  createInMemoryDiseaseFlagRepository,
  createInMemoryHealthRecordRepository,
  createInMemoryMovementPermitRepository,
  createInMemoryMovementRepository,
  createInMemoryRecallRepository
} from '../../database/repositories/livestock-health.repository.js';
import { LivestockHealthService } from './livestock-health.service.js';
import {
  signHealthRecord,
  verifyHealthRecordSignature
} from './health-signing.js';

type UserRef = Pick<User, 'id' | 'roles'>;

const asUser = (ref: UserRef): User => ({
  phone: '+2348000000000',
  fullName: 'Spec User',
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...ref
});

const vet = asUser({ id: 'vet-1', roles: ['vet'] });
const farmer = asUser({ id: 'farmer-1', roles: ['farmer'] });
const otherFarmer = asUser({ id: 'farmer-2', roles: ['farmer'] });
const admin = asUser({ id: 'admin-1', roles: ['admin'] });
const regulator = asUser({ id: 'reg-1', roles: ['regulator'] });

const makeAnimal = (overrides: Partial<Animal> = {}): Animal => ({
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  birthDate: '2022-06-01T00:00:00.000Z',
  ownerUserId: farmer.id,
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides
});

const makeLot = (overrides: Partial<LivestockLot> = {}): LivestockLot => ({
  id: 'LOT-BOV-KD-000001',
  species: 'cattle',
  quantity: 2,
  ownerUserId: farmer.id,
  state: 'Kaduna',
  status: 'open',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides
});

const makeMovement = (overrides: Partial<AnimalMovement> = {}): AnimalMovement => ({
  id: 'movement-seed-1',
  animalId: 'NG-BOV-KD-000001',
  fromState: 'Kaduna',
  toState: 'Lagos',
  departedAt: '2025-03-01T00:00:00.000Z',
  arrivedAt: '2025-03-02T00:00:00.000Z',
  transportMode: 'truck',
  purpose: 'sale',
  recordedBy: farmer.id,
  createdAt: '2025-03-01T00:00:00.000Z',
  ...overrides
});

const animalA = makeAnimal({ id: 'NG-BOV-KD-000001' });
const animalB = makeAnimal({ id: 'NG-BOV-KD-000002' });
const animalC = makeAnimal({ id: 'NG-BOV-LA-000003', ownerUserId: otherFarmer.id, state: 'Lagos' });

describe('LivestockHealthService', () => {
  let animals: ReturnType<typeof createInMemoryAnimalRepository>;
  let lots: ReturnType<typeof createInMemoryLotRepository>;
  let healthRecords: ReturnType<typeof createInMemoryHealthRecordRepository>;
  let movements: ReturnType<typeof createInMemoryMovementRepository>;
  let permits: ReturnType<typeof createInMemoryMovementPermitRepository>;
  let recalls: ReturnType<typeof createInMemoryRecallRepository>;
  let diseaseFlags: ReturnType<typeof createInMemoryDiseaseFlagRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let notifier: { notifyConfirmed: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let events: DomainEventsService;
  let service: LivestockHealthService;

  beforeEach(() => {
    animals = createInMemoryAnimalRepository(undefined, [animalA, animalB, animalC]);
    lots = createInMemoryLotRepository();
    healthRecords = createInMemoryHealthRecordRepository();
    movements = createInMemoryMovementRepository();
    permits = createInMemoryMovementPermitRepository();
    recalls = createInMemoryRecallRepository();
    diseaseFlags = createInMemoryDiseaseFlagRepository();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    notifier = {
      notifyConfirmed: vi.fn().mockResolvedValue({ delivered: false, reason: 'not_configured' })
    };
    outbox = createInMemoryOutboxRepository();
    events = new DomainEventsService(outbox);
    service = new LivestockHealthService(
      audit as never,
      events,
      notifier as never,
      animals,
      lots,
      healthRecords,
      movements,
      permits,
      recalls,
      diseaseFlags
    );
  });

  const vaccinationInput = (overrides: Record<string, unknown> = {}) => ({
    animalId: animalA.id,
    recordType: 'vaccination' as const,
    product: 'FMD',
    batchNumber: 'BATCH-1',
    dose: '2ml',
    administeredAt: '2025-06-01T00:00:00.000Z',
    ...overrides
  });

  const eventNames = async (): Promise<string[]> =>
    (await outbox.list()).map((event) => event.name);

  describe('health ledger — recording and signing', () => {
    it('a vet records a vaccination with a signature over the canonical payload', async () => {
      const record = await service.recordHealth(vet, vaccinationInput());
      expect(record.animalId).toBe(animalA.id);
      expect(record.vetUserId).toBe(vet.id);
      expect(record.signature).toBeTruthy();
      expect(record.reversalOfId).toBeUndefined();
    });

    it('the stored signature verifies through the service', async () => {
      const record = await service.recordHealth(vet, vaccinationInput());
      const result = await service.verifyHealthRecord(farmer, record.id);
      expect(result).toMatchObject({ recordId: record.id, ok: true, reversed: false });
    });

    it('tampering with a signed field breaks verification', async () => {
      const record = await service.recordHealth(vet, vaccinationInput());
      const tampered = { ...record, product: 'CBPP' };
      expect(verifyHealthRecordSignature(tampered, DEV_VET_SIGNING_SECRET).ok).toBe(false);
    });

    it('a signature produced under a different secret fails verification', async () => {
      const record = await service.recordHealth(vet, vaccinationInput());
      expect(verifyHealthRecordSignature(record, 'some-other-secret-key').ok).toBe(false);
    });

    it('signing is deterministic for the same payload and secret', () => {
      const payload = {
        animalId: animalA.id,
        recordType: 'vaccination' as const,
        product: 'FMD',
        batchNumber: 'BATCH-1',
        dose: '2ml',
        administeredAt: '2025-06-01T00:00:00.000Z',
        vetUserId: vet.id,
        signedAt: '2025-06-01T01:00:00.000Z'
      };
      expect(signHealthRecord(payload, 'secret-one')).toBe(signHealthRecord(payload, 'secret-one'));
      expect(signHealthRecord(payload, 'secret-one')).not.toBe(
        signHealthRecord({ ...payload, dose: '3ml' }, 'secret-one')
      );
    });

    it('publishes livestock.health.recorded and writes an audit entry', async () => {
      const record = await service.recordHealth(vet, vaccinationInput());
      expect(await eventNames()).toContain('livestock.health.recorded');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: vet.id,
          action: 'livestock_health.record_created',
          entityId: record.id
        })
      );
    });

    it('rejects non-vet writers (farmer) with 403', async () => {
      await expect(service.recordHealth(farmer, vaccinationInput())).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('rejects regulators from the vet-only write path', async () => {
      await expect(service.recordHealth(regulator, vaccinationInput())).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('rejects anonymous writers with 401', async () => {
      await expect(service.recordHealth(null, vaccinationInput())).rejects.toBeInstanceOf(
        UnauthorizedException
      );
    });

    it('allows admins to record for programme tooling', async () => {
      const record = await service.recordHealth(admin, vaccinationInput());
      expect(record.vetUserId).toBe(admin.id);
    });

    it('404s for an unknown animal', async () => {
      await expect(
        service.recordHealth(vet, vaccinationInput({ animalId: 'NG-BOV-KD-999999' }))
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-ISO administeredAt', async () => {
      await expect(
        service.recordHealth(vet, vaccinationInput({ administeredAt: '1 June 2025' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects withdrawalUntil before administeredAt', async () => {
      await expect(
        service.recordHealth(
          vet,
          vaccinationInput({
            recordType: 'treatment',
            withdrawalUntil: '2025-05-01T00:00:00.000Z'
          })
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects blank product/batch/dose', async () => {
      await expect(
        service.recordHealth(vet, vaccinationInput({ product: '  ' }))
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.recordHealth(vet, vaccinationInput({ batchNumber: '' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('health ledger — append-only corrections', () => {
    it('appends a reversing entry that references the original', async () => {
      const original = await service.recordHealth(vet, vaccinationInput());
      const reversal = await service.reverseHealthRecord(vet, original.id);
      expect(reversal.reversalOfId).toBe(original.id);
      expect(reversal.product).toBe(original.product);
      const storedOriginal = await healthRecords.getById(original.id);
      expect(storedOriginal.reversalOfId).toBeUndefined();
    });

    it('marks the original as reversed when verifying', async () => {
      const original = await service.recordHealth(vet, vaccinationInput());
      await service.reverseHealthRecord(vet, original.id);
      const result = await service.verifyHealthRecord(vet, original.id);
      expect(result.reversed).toBe(true);
    });

    it('the reversing entry itself carries a valid signature', async () => {
      const original = await service.recordHealth(vet, vaccinationInput());
      const reversal = await service.reverseHealthRecord(vet, original.id);
      const result = await service.verifyHealthRecord(vet, reversal.id);
      expect(result.ok).toBe(true);
      expect(result.reversalOfId).toBe(original.id);
    });

    it('rejects a second reversal of the same record', async () => {
      const original = await service.recordHealth(vet, vaccinationInput());
      await service.reverseHealthRecord(vet, original.id);
      await expect(service.reverseHealthRecord(vet, original.id)).rejects.toBeInstanceOf(
        ConflictException
      );
    });

    it('rejects reversing a reversing entry', async () => {
      const original = await service.recordHealth(vet, vaccinationInput());
      const reversal = await service.reverseHealthRecord(vet, original.id);
      await expect(service.reverseHealthRecord(vet, reversal.id)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('keeps the ledger append-only: the port exposes no update/remove', () => {
      expect('update' in healthRecords).toBe(false);
      expect('remove' in healthRecords).toBe(false);
    });
  });

  describe('health ledger — reads and authz', () => {
    it('lists records chronologically for the owner', async () => {
      await service.recordHealth(vet, vaccinationInput({ administeredAt: '2025-07-01T00:00:00.000Z' }));
      await service.recordHealth(vet, vaccinationInput({ administeredAt: '2025-05-01T00:00:00.000Z' }));
      const records = await service.listHealthRecords(farmer, animalA.id);
      expect(records).toHaveLength(2);
      expect(records[0].administeredAt < records[1].administeredAt).toBe(true);
    });

    it('lets vets, regulators and admins read any animal ledger', async () => {
      await service.recordHealth(vet, vaccinationInput());
      await expect(service.listHealthRecords(regulator, animalA.id)).resolves.toHaveLength(1);
      await expect(service.listHealthRecords(admin, animalA.id)).resolves.toHaveLength(1);
    });

    it('blocks other farmers from the ledger', async () => {
      await service.recordHealth(vet, vaccinationInput());
      await expect(service.listHealthRecords(otherFarmer, animalA.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });
  });

  describe('movement log — open/close rules', () => {
    const movementInput = (overrides: Record<string, unknown> = {}) => ({
      animalId: animalA.id,
      fromState: 'Kaduna',
      toState: 'Lagos',
      transportMode: 'truck' as const,
      purpose: 'sale' as const,
      ...overrides
    });

    it('the owner starts a movement; it is open until arrival', async () => {
      const movement = await service.startMovement(farmer, movementInput());
      expect(movement.arrivedAt).toBeUndefined();
      expect(movement.recordedBy).toBe(farmer.id);
      expect(await eventNames()).toContain('livestock.movement.started');
    });

    it('rejects non-owners (admin excepted)', async () => {
      await expect(service.startMovement(otherFarmer, movementInput())).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(service.startMovement(admin, movementInput())).resolves.toBeDefined();
    });

    it('blocks a second movement while one is open', async () => {
      await service.startMovement(farmer, movementInput());
      await expect(service.startMovement(farmer, movementInput())).rejects.toBeInstanceOf(
        ConflictException
      );
    });

    it('allows a new movement after the open one is closed', async () => {
      const first = await service.startMovement(farmer, movementInput());
      await service.recordArrival(farmer, first.id);
      const second = await service.startMovement(farmer, movementInput());
      expect(second.id).not.toBe(first.id);
    });

    it('closes a movement on arrival and rejects double arrival', async () => {
      const movement = await service.startMovement(
        farmer,
        movementInput({ departedAt: '2026-01-01T00:00:00.000Z' })
      );
      const closed = await service.recordArrival(farmer, movement.id, '2026-01-02T00:00:00.000Z');
      expect(closed.arrivedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(await eventNames()).toContain('livestock.movement.arrived');
      await expect(service.recordArrival(farmer, movement.id)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('rejects arrival before departure', async () => {
      const movement = await service.startMovement(
        farmer,
        movementInput({ departedAt: '2026-06-01T00:00:00.000Z' })
      );
      await expect(
        service.recordArrival(farmer, movement.id, '2026-05-01T00:00:00.000Z')
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('arrival requires the owner or an admin', async () => {
      const movement = await service.startMovement(farmer, movementInput());
      await expect(service.recordArrival(otherFarmer, movement.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(service.recordArrival(admin, movement.id)).resolves.toBeDefined();
    });

    it('requires exactly one of animalId/lotId', async () => {
      await expect(
        service.startMovement(farmer, movementInput({ animalId: undefined, lotId: undefined }))
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.startMovement(farmer, movementInput({ lotId: 'LOT-BOV-KD-000001' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown states', async () => {
      await expect(
        service.startMovement(farmer, movementInput({ toState: 'Narnia' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects moving a dead animal', async () => {
      const dead = makeAnimal({ id: 'NG-BOV-KD-000010', status: 'dead' });
      await animals.create(dead);
      await expect(
        service.startMovement(farmer, movementInput({ animalId: dead.id }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('tracks lot movements with the same open/close rules', async () => {
      const lot = makeLot();
      await lots.create(lot);
      const movement = await service.startMovement(
        farmer,
        movementInput({ animalId: undefined, lotId: lot.id })
      );
      expect(movement.lotId).toBe(lot.id);
      await expect(
        service.startMovement(farmer, movementInput({ animalId: undefined, lotId: lot.id }))
      ).rejects.toBeInstanceOf(ConflictException);
      await service.recordArrival(farmer, movement.id);
      const history = await service.listLotMovements(farmer, lot.id);
      expect(history).toHaveLength(1);
      expect(history[0].arrivedAt).toBeDefined();
    });

    it('lists animal movements for privileged readers and blocks strangers', async () => {
      await service.startMovement(farmer, movementInput());
      await expect(service.listAnimalMovements(regulator, animalA.id)).resolves.toHaveLength(1);
      await expect(service.listAnimalMovements(otherFarmer, animalA.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });
  });

  describe('movement permits — lifecycle', () => {
    const permitInput = (overrides: Record<string, unknown> = {}) => ({
      animalIds: [animalA.id],
      fromState: 'Kaduna',
      toState: 'Lagos',
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil: '2099-01-01T00:00:00.000Z',
      ...overrides
    });

    it('a vet issues a permit with a PMT-{FROM}-{TO} number and animal subjects', async () => {
      const permit = await service.issuePermit(vet, permitInput());
      expect(permit.permitNumber).toMatch(/^PMT-KD-LA-[0-9A-F]{8}$/);
      expect(permit.status).toBe('issued');
      expect(permit.issuedBy).toBe(vet.id);
      expect(await eventNames()).toContain('livestock.permit.issued');
    });

    it('a regulator can issue; a farmer cannot', async () => {
      await expect(service.issuePermit(regulator, permitInput())).resolves.toBeDefined();
      await expect(service.issuePermit(farmer, permitInput())).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('requires at least one subject and a sane validity window', async () => {
      await expect(
        service.issuePermit(vet, permitInput({ animalIds: [], lotIds: [] }))
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.issuePermit(vet, permitInput({ validUntil: '2019-01-01T00:00:00.000Z' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s for unknown subject animals', async () => {
      await expect(
        service.issuePermit(vet, permitInput({ animalIds: ['NG-BOV-KD-999999'] }))
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('verifies a valid permit by id and by permit number', async () => {
      const permit = await service.issuePermit(vet, permitInput());
      const byId = await service.verifyPermit(farmer, permit.id);
      expect(byId.verification).toBe('valid');
      expect(byId.subjects).toEqual([
        { permitId: permit.id, subjectType: 'animal', subjectId: animalA.id }
      ]);
      const byNumber = await service.verifyPermit(farmer, permit.permitNumber);
      expect(byNumber.permit.id).toBe(permit.id);
    });

    it('reports expired for a permit outside its validity window', async () => {
      const permit = await service.issuePermit(
        vet,
        permitInput({ validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2020-12-31T00:00:00.000Z' })
      );
      const result = await service.verifyPermit(farmer, permit.id);
      expect(result.verification).toBe('expired');
    });

    it('reports revoked after revocation with a reason', async () => {
      const permit = await service.issuePermit(vet, permitInput());
      const revoked = await service.revokePermit(regulator, permit.id, 'Border closure');
      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedReason).toBe('Border closure');
      const result = await service.verifyPermit(farmer, permit.id);
      expect(result.verification).toBe('revoked');
      expect(await eventNames()).toContain('livestock.permit.revoked');
    });

    it('rejects double revocation, missing reasons and farmer revocations', async () => {
      const permit = await service.issuePermit(vet, permitInput());
      await service.revokePermit(vet, permit.id, 'Duplicate issuance');
      await expect(
        service.revokePermit(vet, permit.id, 'Again')
      ).rejects.toBeInstanceOf(BadRequestException);
      const second = await service.issuePermit(vet, permitInput());
      await expect(service.revokePermit(vet, second.id, ' ')).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(service.revokePermit(farmer, second.id, 'Nope')).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('rejects verification of unknown permits', async () => {
      await expect(service.verifyPermit(farmer, 'PMT-XX-YY-00000000')).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('gates permit-backed movements on permit validity, route and coverage', async () => {
      const permit = await service.issuePermit(vet, permitInput());
      const movement = await service.startMovement(farmer, {
        animalId: animalA.id,
        fromState: 'Kaduna',
        toState: 'Lagos',
        transportMode: 'truck',
        purpose: 'sale',
        permitId: permit.id
      });
      expect(movement.permitId).toBe(permit.id);

      const wrongRoute = await service.issuePermit(
        vet,
        permitInput({ animalIds: [animalB.id], toState: 'Kano' })
      );
      await expect(
        service.startMovement(farmer, {
          animalId: animalB.id,
          fromState: 'Kaduna',
          toState: 'Lagos',
          transportMode: 'truck',
          purpose: 'sale',
          permitId: wrongRoute.id
        })
      ).rejects.toBeInstanceOf(BadRequestException);

      await service.recordArrival(farmer, movement.id);
      const notCovering = await service.issuePermit(vet, permitInput({ animalIds: [animalB.id] }));
      await expect(
        service.startMovement(farmer, {
          animalId: animalA.id,
          fromState: 'Kaduna',
          toState: 'Lagos',
          transportMode: 'truck',
          purpose: 'sale',
          permitId: notCovering.id
        })
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('blocks movements on revoked or expired permits', async () => {
      const revoked = await service.issuePermit(vet, permitInput());
      await service.revokePermit(vet, revoked.id, 'Fraud');
      await expect(
        service.startMovement(farmer, {
          animalId: animalA.id,
          fromState: 'Kaduna',
          toState: 'Lagos',
          transportMode: 'truck',
          purpose: 'sale',
          permitId: revoked.id
        })
      ).rejects.toBeInstanceOf(BadRequestException);

      const expired = await service.issuePermit(
        vet,
        permitInput({
          animalIds: [animalB.id],
          validFrom: '2020-01-01T00:00:00.000Z',
          validUntil: '2020-12-31T00:00:00.000Z'
        })
      );
      await expect(
        service.startMovement(farmer, {
          animalId: animalB.id,
          fromState: 'Kaduna',
          toState: 'Lagos',
          transportMode: 'truck',
          purpose: 'sale',
          permitId: expired.id
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('recall — scope computation and lifecycle', () => {
    const recallInput = (overrides: Record<string, unknown> = {}) => ({
      reason: 'FMD-contaminated batch',
      ...overrides
    });

    it('animal scope affects the animal and publishes the initiated event', async () => {
      const { recall, animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ animalId: animalA.id })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id]);
      expect(recall.status).toBe('initiated');
      expect(recall.scope).toBe('animal');
      const initiated = (await outbox.list()).find(
        (event) => event.name === 'livestock.recall.initiated'
      );
      expect(initiated?.payload).toMatchObject({
        recallId: recall.id,
        animalIds: [animalA.id],
        ownerUserIds: [farmer.id]
      });
    });

    it('lot scope affects every current lot member', async () => {
      const lot = makeLot();
      await lots.create(lot);
      await lots.addAnimal(lot.id, animalA.id);
      await lots.addAnimal(lot.id, animalB.id);
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ lotId: lot.id })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id, animalB.id]);
    });

    it('owner scope affects every animal the owner holds', async () => {
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ ownerUserId: farmer.id })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id, animalB.id]);
    });

    it('region scope with a batch filter matches only animals carrying that batch', async () => {
      await service.recordHealth(vet, vaccinationInput({ batchNumber: 'BATCH-1' }));
      await service.recordHealth(
        vet,
        vaccinationInput({ animalId: animalB.id, batchNumber: 'BATCH-2' })
      );
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ state: 'Kaduna', batchNumber: 'BATCH-1' })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id]);
    });

    it('region scope with a date range matches health records inside the window', async () => {
      await service.recordHealth(
        vet,
        vaccinationInput({ administeredAt: '2025-06-10T00:00:00.000Z' })
      );
      await service.recordHealth(
        vet,
        vaccinationInput({ animalId: animalB.id, administeredAt: '2025-08-01T00:00:00.000Z' })
      );
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({
          state: 'Kaduna',
          fromDate: '2025-06-01T00:00:00.000Z',
          toDate: '2025-06-30T00:00:00.000Z'
        })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id]);
    });

    it('region scope also matches movements departing inside the window', async () => {
      await movements.create(
        makeMovement({
          id: 'movement-region-1',
          animalId: animalB.id,
          departedAt: '2025-06-15T00:00:00.000Z'
        })
      );
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({
          state: 'Kaduna',
          fromDate: '2025-06-01T00:00:00.000Z',
          toDate: '2025-06-30T00:00:00.000Z'
        })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalB.id]);
    });

    it('region scope without a window matches every animal in the state', async () => {
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ state: 'Kaduna' })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id, animalB.id]);
    });

    it('a batch filter intersects the owner scope', async () => {
      await service.recordHealth(vet, vaccinationInput({ batchNumber: 'BATCH-1' }));
      await service.recordHealth(
        vet,
        vaccinationInput({ animalId: animalB.id, batchNumber: 'BATCH-2' })
      );
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ ownerUserId: farmer.id, batchNumber: 'BATCH-1' })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id]);
    });

    it('expands through lot membership (shared pens spread contamination)', async () => {
      const lot = makeLot();
      await lots.create(lot);
      await lots.addAnimal(lot.id, animalA.id);
      await lots.addAnimal(lot.id, animalB.id);
      const { animals: affected } = await service.initiateRecall(
        regulator,
        recallInput({ animalId: animalA.id })
      );
      expect(affected.map((entry) => entry.animalId)).toEqual([animalA.id, animalB.id]);
    });

    it('rejects ambiguous, empty and matchless scopes', async () => {
      await expect(
        service.initiateRecall(regulator, recallInput({ animalId: animalA.id, lotId: 'LOT-1' }))
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.initiateRecall(regulator, recallInput())).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(
        service.initiateRecall(regulator, recallInput({ ownerUserId: 'ghost-user' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recalls/mine: owners see only recalls affecting their own animals (G18)', async () => {
      const { recall: mine } = await service.initiateRecall(
        regulator,
        recallInput({ animalId: animalA.id })
      );
      const { recall: otherRecall } = await service.initiateRecall(
        regulator,
        recallInput({ animalId: animalC.id })
      );
      const farmerRecalls = await service.listMyRecalls(farmer);
      expect(farmerRecalls.map((recall) => recall.id)).toEqual([mine.id]);
      const otherRecalls = await service.listMyRecalls(otherFarmer);
      expect(otherRecalls.map((recall) => recall.id)).toEqual([otherRecall.id]);
    });

    it('recalls/mine: a user with no affected animals sees an empty list', async () => {
      await service.initiateRecall(regulator, recallInput({ animalId: animalA.id }));
      expect(await service.listMyRecalls(vet)).toEqual([]);
      // Unauthenticated callers are rejected.
      await expect(service.listMyRecalls(null)).rejects.toThrow();
    });

    it('requires a reason and a sane date range', async () => {
      await expect(
        service.initiateRecall(regulator, { animalId: animalA.id, reason: ' ' })
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.initiateRecall(
          regulator,
          recallInput({
            state: 'Kaduna',
            fromDate: '2025-06-30T00:00:00.000Z',
            toDate: '2025-06-01T00:00:00.000Z'
          })
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is restricted to regulators and admins', async () => {
      await expect(
        service.initiateRecall(farmer, recallInput({ animalId: animalA.id }))
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.initiateRecall(vet, recallInput({ animalId: animalA.id }))
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.initiateRecall(admin, recallInput({ animalId: animalA.id }))
      ).resolves.toBeDefined();
    });

    it('lets affected owners read the case and blocks strangers', async () => {
      const { recall } = await service.initiateRecall(
        regulator,
        recallInput({ animalId: animalA.id })
      );
      const view = await service.getRecall(farmer, recall.id);
      expect(view.animals).toHaveLength(1);
      await expect(service.getRecall(otherFarmer, recall.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(service.getRecall(regulator, recall.id)).resolves.toBeDefined();
    });

    it('restricts recall listing to regulators/admins', async () => {
      await service.initiateRecall(regulator, recallInput({ animalId: animalA.id }));
      await expect(service.listRecalls(regulator, {})).resolves.toHaveLength(1);
      await expect(service.listRecalls(farmer, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('walks the lifecycle initiated → notified → resolved', async () => {
      const { recall } = await service.initiateRecall(
        regulator,
        recallInput({ animalId: animalA.id })
      );
      await expect(service.resolveRecall(regulator, recall.id)).rejects.toBeInstanceOf(
        BadRequestException
      );
      const notified = await service.markRecallNotified(recall.id);
      expect(notified.status).toBe('notified');
      expect(notified.notifiedAt).toBeDefined();
      await expect(service.markRecallNotified(recall.id)).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(service.resolveRecall(farmer, recall.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      const resolved = await service.resolveRecall(regulator, recall.id);
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedAt).toBeDefined();
      expect(await eventNames()).toContain('livestock.recall.resolved');
    });
  });

  describe('disease surveillance — flags and state map', () => {
    const flagInput = (overrides: Record<string, unknown> = {}) => ({
      disease: 'FMD',
      state: 'Kaduna',
      lga: 'Zaria',
      suspectedSpecies: 'cattle' as const,
      ...overrides
    });

    it('any authenticated user reports a flag', async () => {
      const flag = await service.reportDiseaseFlag(farmer, flagInput());
      expect(flag.status).toBe('reported');
      expect(flag.reporterUserId).toBe(farmer.id);
      expect(await eventNames()).toContain('livestock.disease_flag.reported');
    });

    it('validates disease and state', async () => {
      await expect(service.reportDiseaseFlag(farmer, flagInput({ disease: ' ' }))).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(
        service.reportDiseaseFlag(farmer, flagInput({ state: 'Narnia' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a vet confirms a reported flag and the notifier is invoked', async () => {
      const flag = await service.reportDiseaseFlag(farmer, flagInput());
      const { flag: confirmed, notification } = await service.confirmDiseaseFlag(vet, flag.id);
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.confirmedBy).toBe(vet.id);
      expect(notifier.notifyConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ id: flag.id, status: 'confirmed' })
      );
      expect(notification.delivered).toBe(false);
      expect(await eventNames()).toContain('livestock.disease_flag.confirmed');
    });

    it('blocks farmers from confirming and rejects non-reported flags', async () => {
      const flag = await service.reportDiseaseFlag(farmer, flagInput());
      await expect(service.confirmDiseaseFlag(farmer, flag.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await service.confirmDiseaseFlag(regulator, flag.id);
      await expect(service.confirmDiseaseFlag(vet, flag.id)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('retracts as a false positive with a mandatory reason (reporter)', async () => {
      const flag = await service.reportDiseaseFlag(farmer, flagInput());
      const retracted = await service.retractDiseaseFlag(farmer, flag.id, 'Lab test negative');
      expect(retracted.status).toBe('retracted');
      expect(retracted.retractedReason).toBe('Lab test negative');
      expect(await eventNames()).toContain('livestock.disease_flag.retracted');
    });

    it('blocks stranger retractions; regulators may retract; double retract fails', async () => {
      const flag = await service.reportDiseaseFlag(farmer, flagInput());
      await expect(
        service.retractDiseaseFlag(otherFarmer, flag.id, 'Not mine')
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.retractDiseaseFlag(regulator, flag.id, ' ')).rejects.toBeInstanceOf(
        BadRequestException
      );
      await service.retractDiseaseFlag(regulator, flag.id, 'Duplicate report');
      await expect(
        service.retractDiseaseFlag(farmer, flag.id, 'Again')
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('aggregates confirmed flags by state and disease for the dashboard', async () => {
      const first = await service.reportDiseaseFlag(farmer, flagInput());
      const second = await service.reportDiseaseFlag(
        otherFarmer,
        flagInput({ disease: 'FMD', lga: 'Kano Municipal' })
      );
      const third = await service.reportDiseaseFlag(farmer, flagInput({ disease: 'Anthrax' }));
      const lagos = await service.reportDiseaseFlag(
        otherFarmer,
        flagInput({ state: 'Lagos', disease: 'FMD' })
      );
      const reportedOnly = await service.reportDiseaseFlag(farmer, flagInput({ disease: 'PPR' }));
      await service.confirmDiseaseFlag(vet, first.id);
      await service.confirmDiseaseFlag(vet, second.id);
      await service.confirmDiseaseFlag(vet, third.id);
      await service.confirmDiseaseFlag(vet, lagos.id);

      const map = await service.diseaseMap(regulator);
      expect(map).toEqual([
        expect.objectContaining({ state: 'Kaduna', disease: 'Anthrax', confirmedFlags: 1 }),
        expect.objectContaining({ state: 'Kaduna', disease: 'FMD', confirmedFlags: 2 }),
        expect.objectContaining({ state: 'Lagos', disease: 'FMD', confirmedFlags: 1 })
      ]);
      const kadunaOnly = await service.diseaseMap(regulator, 'Kaduna');
      expect(kadunaOnly).toHaveLength(2);
      expect(reportedOnly.status).toBe('reported');
    });

    it('excludes retracted flags from the disease map', async () => {
      const flag = await service.reportDiseaseFlag(farmer, flagInput());
      await service.confirmDiseaseFlag(vet, flag.id);
      await service.retractDiseaseFlag(regulator, flag.id, 'False positive');
      await expect(service.diseaseMap(regulator)).resolves.toEqual([]);
    });
  });

  describe('trust grade — rubric boundaries', () => {
    const daysAgo = (days: number): string =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const daysAhead = (days: number): string =>
      new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const vaccinate = async (animalId: string, product: string): Promise<void> => {
      await service.recordHealth(
        vet,
        vaccinationInput({ animalId, product, administeredAt: daysAgo(30) })
      );
    };

    let movementSeq = 0;
    const seedMovements = async (animalId: string, count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        movementSeq += 1;
        await movements.create(
          makeMovement({ id: `movement-${animalId}-${movementSeq}`, animalId })
        );
      }
    };

    it('grades A at 100 points: full coverage, no treatments, few movements, prime age', async () => {
      await vaccinate(animalA.id, 'FMD');
      await vaccinate(animalA.id, 'CBPP');
      await vaccinate(animalA.id, 'Anthrax');
      const result = await service.gradeAnimal(farmer, animalA.id);
      expect(result.score).toBe(100);
      expect(result.grade).toBe('A');
      expect(result.components.vaccinationCoverage).toBe(1);
      expect(result.components.completedVaccinations).toEqual(['FMD', 'CBPP', 'Anthrax']);
    });

    it('grades A at the 85-point boundary', async () => {
      // 50 (full coverage) + 20 (no treatments) + 10 (4–10 movements) + 5 (unknown age).
      const noBirthDate = makeAnimal({ id: 'NG-BOV-KD-000020', birthDate: undefined });
      await animals.create(noBirthDate);
      await vaccinate(noBirthDate.id, 'FMD');
      await vaccinate(noBirthDate.id, 'CBPP');
      await vaccinate(noBirthDate.id, 'Anthrax');
      await seedMovements(noBirthDate.id, 4);
      const result = await service.gradeAnimal(farmer, noBirthDate.id);
      expect(result.score).toBe(85);
      expect(result.grade).toBe('A');
    });

    it('grades B in the 70–84 band', async () => {
      // 33 (2/3 coverage) + 20 + 15 + 15 = 83.
      await vaccinate(animalA.id, 'FMD');
      await vaccinate(animalA.id, 'CBPP');
      const result = await service.gradeAnimal(farmer, animalA.id);
      expect(result.score).toBe(83);
      expect(result.grade).toBe('B');
      expect(result.components.vaccinationPoints).toBe(33);
    });

    it('grades B at the 70-point boundary', async () => {
      // 50 (full coverage) + 10 (recent treatment, withdrawal passed) + 5 (>10 movements) + 5 (unknown age).
      const noBirthDate = makeAnimal({ id: 'NG-BOV-KD-000021', birthDate: undefined });
      await animals.create(noBirthDate);
      await vaccinate(noBirthDate.id, 'FMD');
      await vaccinate(noBirthDate.id, 'CBPP');
      await vaccinate(noBirthDate.id, 'Anthrax');
      await service.recordHealth(
        vet,
        vaccinationInput({
          animalId: noBirthDate.id,
          recordType: 'treatment',
          product: 'Oxytetracycline',
          administeredAt: daysAgo(10),
          withdrawalUntil: daysAgo(2)
        })
      );
      await seedMovements(noBirthDate.id, 11);
      const result = await service.gradeAnimal(farmer, noBirthDate.id);
      expect(result.score).toBe(70);
      expect(result.grade).toBe('B');
      expect(result.components.movementPoints).toBe(5);
    });

    it('grades C at the 50-point boundary', async () => {
      // 17 (1/3 coverage) + 10 (recent treatment) + 15 (≤3 movements) + 8 (known age outside prime).
      const old = makeAnimal({ id: 'NG-BOV-KD-000022', birthDate: '2010-01-01T00:00:00.000Z' });
      await animals.create(old);
      await vaccinate(old.id, 'FMD');
      await service.recordHealth(
        vet,
        vaccinationInput({
          animalId: old.id,
          recordType: 'treatment',
          product: 'Ivermectin',
          administeredAt: daysAgo(5)
        })
      );
      const result = await service.gradeAnimal(farmer, old.id);
      expect(result.score).toBe(50);
      expect(result.grade).toBe('C');
      expect(result.components.agePoints).toBe(8);
    });

    it('grades D below 50 points', async () => {
      // 0 (no coverage) + 20 (no treatments) + 15 (≤3 movements) + 8 (old age) = 43.
      const old = makeAnimal({ id: 'NG-BOV-KD-000023', birthDate: '2009-01-01T00:00:00.000Z' });
      await animals.create(old);
      const result = await service.gradeAnimal(farmer, old.id);
      expect(result.score).toBe(43);
      expect(result.grade).toBe('D');
    });

    it('zeroes treatment points while a withdrawal window is active', async () => {
      await service.recordHealth(
        vet,
        vaccinationInput({
          recordType: 'treatment',
          product: 'Penicillin',
          administeredAt: daysAgo(3),
          withdrawalUntil: daysAhead(7)
        })
      );
      const result = await service.gradeAnimal(farmer, animalA.id);
      expect(result.components.treatmentPoints).toBe(0);
    });

    it('scores 20 treatment points when the latest treatment is older than 90 days', async () => {
      await service.recordHealth(
        vet,
        vaccinationInput({
          recordType: 'treatment',
          product: 'Penicillin',
          administeredAt: '2020-01-01T00:00:00.000Z'
        })
      );
      const result = await service.gradeAnimal(farmer, animalA.id);
      expect(result.components.treatmentPoints).toBe(20);
    });

    it('scores movement bands: ≤3 → 15, ≤10 → 10, more → 5', async () => {
      await seedMovements(animalA.id, 3);
      expect((await service.gradeAnimal(farmer, animalA.id)).components.movementPoints).toBe(15);
      await seedMovements(animalA.id, 4);
      expect((await service.gradeAnimal(farmer, animalA.id)).components.movementPoints).toBe(10);
      await seedMovements(animalA.id, 4);
      expect((await service.gradeAnimal(farmer, animalA.id)).components.movementPoints).toBe(5);
    });

    it('excludes reversed vaccinations from coverage', async () => {
      const record = await service.recordHealth(
        vet,
        vaccinationInput({ product: 'FMD', administeredAt: daysAgo(30) })
      );
      await service.reverseHealthRecord(vet, record.id, 'Wrong batch recorded');
      const result = await service.gradeAnimal(farmer, animalA.id);
      expect(result.components.completedVaccinations).toEqual([]);
      expect(result.components.vaccinationPoints).toBe(0);
    });

    it('awards 5 age points for an unknown birthDate and 15 for prime age', async () => {
      const noBirthDate = makeAnimal({ id: 'NG-BOV-KD-000024', birthDate: undefined });
      await animals.create(noBirthDate);
      expect((await service.gradeAnimal(farmer, noBirthDate.id)).components.agePoints).toBe(5);
      expect((await service.gradeAnimal(farmer, animalA.id)).components.agePoints).toBe(15);
    });

    it('gates grade reads to owner/admin/vet/regulator', async () => {
      await expect(service.gradeAnimal(otherFarmer, animalA.id)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(service.gradeAnimal(vet, animalA.id)).resolves.toBeDefined();
      await expect(service.gradeAnimal(regulator, animalA.id)).resolves.toBeDefined();
    });
  });

  describe('due vaccinations — computed schedule', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

    const dueFor = (items: VaccinationDueItem[], animalId: string, vaccine: string) =>
      items.find((item) => item.animalId === animalId && item.vaccine === vaccine);

    it('requires authentication', async () => {
      await expect(service.listDueVaccinations(null)).rejects.toBeInstanceOf(
        UnauthorizedException
      );
    });

    it('marks never-vaccinated animals overdue from their registration date', async () => {
      const items = await service.listDueVaccinations(farmer);
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({
        status: 'overdue',
        dueDate: animalA.createdAt,
        lastAdministeredAt: undefined
      });
      // Registration was 2025-01-01 — well over a day overdue.
      expect(fmd!.daysOverdue).toBeGreaterThan(30);
      // Cattle schedule covers FMD, CBPP and Anthrax for each own animal.
      expect(items.filter((item) => item.animalId === animalA.id)).toHaveLength(3);
    });

    it('scopes farmers to their own animals only', async () => {
      const items = await service.listDueVaccinations(farmer);
      const animalIds = new Set(items.map((item) => item.animalId));
      expect(animalIds).toEqual(new Set([animalA.id, animalB.id]));
      expect(animalIds.has(animalC.id)).toBe(false);
    });

    it('rejects a farmer filtering by another owner but allows their own id', async () => {
      await expect(
        service.listDueVaccinations(farmer, { ownerUserId: otherFarmer.id })
      ).rejects.toBeInstanceOf(ForbiddenException);
      const items = await service.listDueVaccinations(farmer, { ownerUserId: farmer.id });
      expect(items.every((item) => item.animalId !== animalC.id)).toBe(true);
    });

    it('lets admin/vet/regulator see all animals and filter by ownerUserId', async () => {
      for (const reader of [admin, vet, regulator]) {
        const all = await service.listDueVaccinations(reader);
        expect(new Set(all.map((item) => item.animalId))).toEqual(
          new Set([animalA.id, animalB.id, animalC.id])
        );
        const filtered = await service.listDueVaccinations(reader, { ownerUserId: otherFarmer.id });
        expect(new Set(filtered.map((item) => item.animalId))).toEqual(new Set([animalC.id]));
      }
    });

    it('computes upcoming when the booster is beyond the lookahead window', async () => {
      // FMD interval is 180 days; vaccinated 30 days ago → due in ~150 days.
      const administeredAt = daysAgo(30);
      await service.recordHealth(vet, vaccinationInput({ administeredAt }));
      const items = await service.listDueVaccinations(farmer);
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({ status: 'upcoming', lastAdministeredAt: administeredAt });
      expect(fmd!.daysUntilDue).toBe(150);
      expect(fmd!.dueDate).toBe(new Date(Date.parse(administeredAt) + 180 * DAY_MS).toISOString());
    });

    it('marks a vaccination due when it falls inside the lookahead window', async () => {
      await service.recordHealth(vet, vaccinationInput({ administeredAt: daysAgo(175) }));
      const items = await service.listDueVaccinations(farmer, { days: 30 });
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({ status: 'due', daysUntilDue: 5 });
    });

    it('marks a vaccination overdue once the interval has passed', async () => {
      await service.recordHealth(vet, vaccinationInput({ administeredAt: daysAgo(200) }));
      const items = await service.listDueVaccinations(farmer);
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({ status: 'overdue', daysOverdue: 20 });
    });

    it('treats a vaccination due exactly now as overdue with zero days', async () => {
      await service.recordHealth(vet, vaccinationInput({ administeredAt: daysAgo(180) }));
      const items = await service.listDueVaccinations(farmer);
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({ status: 'overdue', daysOverdue: 0 });
    });

    it('honours per-vaccine intervals (Newcastle 120 days for poultry)', async () => {
      const bird = makeAnimal({
        id: 'NG-AVI-KD-000101',
        species: 'chicken',
        birthDate: undefined
      });
      await animals.create(bird);
      await service.recordHealth(
        vet,
        vaccinationInput({
          animalId: bird.id,
          product: 'Newcastle',
          administeredAt: daysAgo(115)
        })
      );
      const items = await service.listDueVaccinations(farmer, { days: 30 });
      const newcastle = dueFor(items, bird.id, 'Newcastle');
      expect(newcastle).toMatchObject({ status: 'due', daysUntilDue: 5 });
      // Gumboro/Fowl Pox (365-day interval, never administered) stay overdue.
      expect(dueFor(items, bird.id, 'Gumboro')!.status).toBe('overdue');
    });

    it('ignores reversed vaccinations when computing the last dose', async () => {
      const record = await service.recordHealth(
        vet,
        vaccinationInput({ administeredAt: daysAgo(30) })
      );
      await service.reverseHealthRecord(vet, record.id, 'Wrong batch recorded');
      const items = await service.listDueVaccinations(farmer);
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({ status: 'overdue', lastAdministeredAt: undefined });
    });

    it('uses the latest dose when an animal was vaccinated more than once', async () => {
      await service.recordHealth(vet, vaccinationInput({ administeredAt: daysAgo(200) }));
      await service.recordHealth(
        vet,
        vaccinationInput({ administeredAt: daysAgo(10), batchNumber: 'BATCH-2' })
      );
      const items = await service.listDueVaccinations(farmer);
      const fmd = dueFor(items, animalA.id, 'FMD');
      expect(fmd).toMatchObject({ status: 'upcoming', daysUntilDue: 170 });
    });

    it('excludes animals that are no longer alive', async () => {
      await animals.create(makeAnimal({ id: 'NG-BOV-KD-000090', status: 'dead' }));
      await animals.create(makeAnimal({ id: 'NG-BOV-KD-000091', status: 'sold' }));
      const items = await service.listDueVaccinations(farmer);
      const animalIds = new Set(items.map((item) => item.animalId));
      expect(animalIds.has('NG-BOV-KD-000090')).toBe(false);
      expect(animalIds.has('NG-BOV-KD-000091')).toBe(false);
    });

    it('sorts by due date ascending (most urgent first)', async () => {
      await service.recordHealth(vet, vaccinationInput({ administeredAt: daysAgo(30) }));
      const items = await service.listDueVaccinations(farmer, { days: 365 });
      const dueDates = items.map((item) => item.dueDate);
      expect([...dueDates].sort()).toEqual(dueDates);
      // The FMD booster (upcoming) sorts after the overdue never-vaccinated rows.
      expect(items.at(-1)).toMatchObject({ animalId: animalA.id, vaccine: 'FMD', status: 'due' });
    });
  });
});
