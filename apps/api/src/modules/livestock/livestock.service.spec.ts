import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository,
  createInMemoryPastoralistProfileRepository,
} from '../../database/repositories/livestock.repository.js';
import { LivestockService } from './livestock.service.js';

type UserRef = Pick<User, 'id' | 'roles'>;
const asUser = (ref: UserRef): User => ref as User;

const farmer: User = asUser({ id: 'farmer-1', roles: ['farmer'] });
const otherFarmer: User = asUser({ id: 'farmer-2', roles: ['farmer'] });
const admin: User = asUser({ id: 'admin-1', roles: ['admin'] });

const baseAnimalInput = {
  species: 'cattle' as const,
  breed: 'White Fulani',
  sex: 'female' as const,
  state: 'Kaduna',
  lga: 'Zaria',
};

describe('LivestockService', () => {
  let animals: ReturnType<typeof createInMemoryAnimalRepository>;
  let transfers: ReturnType<typeof createInMemoryOwnershipTransferRepository>;
  let lots: ReturnType<typeof createInMemoryLotRepository>;
  let profiles: ReturnType<typeof createInMemoryPastoralistProfileRepository>;
  let users: { getById: ReturnType<typeof vi.fn>; setRoles: ReturnType<typeof vi.fn> };
  let privacy: { grantConsent: ReturnType<typeof vi.fn>; consentsFor: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let service: LivestockService;

  beforeEach(() => {
    transfers = createInMemoryOwnershipTransferRepository();
    animals = createInMemoryAnimalRepository(transfers);
    lots = createInMemoryLotRepository();
    profiles = createInMemoryPastoralistProfileRepository();
    users = {
      getById: vi.fn().mockImplementation(async (id: string) => ({ id, roles: ['farmer'] })),
      setRoles: vi.fn().mockResolvedValue(undefined),
    };
    privacy = {
      grantConsent: vi.fn().mockImplementation(async (input: { userId: string }) => ({
        id: `consent-${input.userId}`,
        purpose: 'livestock_records',
        granted: true,
      })),
      consentsFor: vi.fn().mockResolvedValue([]),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    service = new LivestockService(
      users as never,
      privacy as never,
      audit as never,
      new DomainEventsService(outbox),
      animals,
      lots,
      transfers,
      profiles,
    );
  });

  describe('enrol', () => {
    it('binds the farmer role when missing and reports roleBound', async () => {
      users.getById.mockResolvedValue({ id: 'user-9', roles: ['buyer'] });
      const result = await service.enrol(admin, 'user-9');
      expect(users.setRoles).toHaveBeenCalledWith('user-9', ['buyer', 'farmer']);
      expect(result.roleBound).toBe(true);
      expect(result.alreadyEnrolled).toBe(false);
    });

    it('leaves roles untouched when the farmer marker already exists', async () => {
      users.getById.mockResolvedValue({ id: 'user-9', roles: ['farmer'] });
      const result = await service.enrol(admin, 'user-9');
      expect(users.setRoles).not.toHaveBeenCalled();
      expect(result.roleBound).toBe(false);
    });

    it('captures livestock_records consent with the enrolment source', async () => {
      await service.enrol(admin, 'user-9');
      expect(privacy.grantConsent).toHaveBeenCalledWith({
        userId: 'user-9',
        purpose: 'livestock_records',
        granted: true,
        source: 'livestock_enrolment',
      });
    });

    it('returns the consent id from the privacy service', async () => {
      const result = await service.enrol(admin, 'user-9');
      expect(result.consentId).toBe('consent-user-9');
    });

    it('replays existing consent idempotently instead of re-granting', async () => {
      privacy.consentsFor.mockResolvedValue([
        { id: 'consent-existing', purpose: 'livestock_records', granted: true },
      ]);
      const result = await service.enrol(admin, 'user-9');
      expect(privacy.grantConsent).not.toHaveBeenCalled();
      expect(result.consentId).toBe('consent-existing');
      expect(result.alreadyEnrolled).toBe(true);
    });

    it('ignores revoked consent and grants afresh', async () => {
      privacy.consentsFor.mockResolvedValue([
        {
          id: 'consent-revoked',
          purpose: 'livestock_records',
          granted: true,
          revokedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const result = await service.enrol(admin, 'user-9');
      expect(privacy.grantConsent).toHaveBeenCalled();
      expect(result.alreadyEnrolled).toBe(false);
    });

    it('allows a farmer to enrol themselves', async () => {
      users.getById.mockResolvedValue({ id: farmer.id, roles: [] });
      const result = await service.enrol(farmer, farmer.id);
      expect(result.userId).toBe(farmer.id);
    });

    it('denies enrolling another user without the admin role', async () => {
      await expect(service.enrol(farmer, 'user-9')).rejects.toThrow(
        'You may only access your own records',
      );
    });

    it('propagates user-not-found from the users service', async () => {
      users.getById.mockRejectedValue(new NotFoundException('User not found.'));
      await expect(service.enrol(admin, 'missing')).rejects.toThrow('User not found.');
    });

    it('audits the enrolment with consent metadata', async () => {
      await service.enrol(admin, 'user-9');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: admin.id,
          action: 'livestock.enrolment_completed',
          entityType: 'user',
          entityId: 'user-9',
        }),
      );
    });

    it('publishes the livestock.enrolment.completed event', async () => {
      await service.enrol(admin, 'user-9');
      const emitted = await outbox.list();
      expect(emitted.some((event) => event.name === 'livestock.enrolment.completed')).toBe(true);
    });
  });

  describe('registerAnimal', () => {
    it('issues the national ID in NG-{species}-{state}-{serial} format', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      expect(animal.id).toBe('NG-BOV-KD-000001');
    });

    it('increments the serial within a species/state pair', async () => {
      const first = await service.registerAnimal(farmer, baseAnimalInput);
      const second = await service.registerAnimal(farmer, baseAnimalInput);
      expect(first.id).toBe('NG-BOV-KD-000001');
      expect(second.id).toBe('NG-BOV-KD-000002');
    });

    it('keeps serial counters independent across species', async () => {
      const bovine = await service.registerAnimal(farmer, baseAnimalInput);
      const chicken = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        species: 'chicken',
        breed: 'Noiler',
      });
      expect(bovine.id).toBe('NG-BOV-KD-000001');
      expect(chicken.id).toBe('NG-AVI-KD-000001');
    });

    it('keeps serial counters independent across states', async () => {
      const kaduna = await service.registerAnimal(farmer, baseAnimalInput);
      const sokoto = await service.registerAnimal(farmer, { ...baseAnimalInput, state: 'Sokoto' });
      expect(kaduna.id).toBe('NG-BOV-KD-000001');
      expect(sokoto.id).toBe('NG-BOV-SO-000001');
    });

    it('persists the registration attributes with alive status', async () => {
      const animal = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        birthDate: '2023-05-01',
        tagId: 'TAG-77',
        eid: 'EID-99',
        notes: 'Calm temperament',
      });
      expect(animal.ownerUserId).toBe(farmer.id);
      expect(animal.status).toBe('alive');
      expect(animal.birthDate).toBe('2023-05-01');
      expect(animal.tagId).toBe('TAG-77');
      expect(animal.eid).toBe('EID-99');
      expect(animal.notes).toBe('Calm temperament');
    });

    it('rejects an unsupported species', async () => {
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, species: 'camel' as never }),
      ).rejects.toThrow("Unknown livestock species 'camel'");
    });

    it('rejects a breed that does not belong to the species', async () => {
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, breed: 'Noiler' }),
      ).rejects.toThrow("Unknown cattle breed 'Noiler'");
    });

    it('rejects an unknown Nigerian state', async () => {
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, state: 'Atlantis' }),
      ).rejects.toThrow("Unknown Nigerian state 'Atlantis'");
    });

    it('rejects a duplicate visual tag id', async () => {
      await service.registerAnimal(farmer, { ...baseAnimalInput, tagId: 'DUP-1' });
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, tagId: 'DUP-1' }),
      ).rejects.toThrow("Tag id 'DUP-1' is already registered");
    });

    it('links sire and dam from the registry', async () => {
      const sire = await service.registerAnimal(farmer, { ...baseAnimalInput, sex: 'male' });
      const dam = await service.registerAnimal(farmer, baseAnimalInput);
      const calf = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        sireId: sire.id,
        damId: dam.id,
      });
      expect(calf.sireId).toBe(sire.id);
      expect(calf.damId).toBe(dam.id);
    });

    it('rejects an unregistered sire', async () => {
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, sireId: 'NG-BOV-KD-999999' }),
      ).rejects.toThrow("sire 'NG-BOV-KD-999999' is not a registered animal");
    });

    it('rejects an unregistered dam', async () => {
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, damId: 'NG-BOV-KD-999999' }),
      ).rejects.toThrow("dam 'NG-BOV-KD-999999' is not a registered animal");
    });

    it('rejects a parent of a different species', async () => {
      const goat = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        species: 'goat',
        breed: 'Red Sokoto',
        sex: 'male',
      });
      await expect(
        service.registerAnimal(farmer, { ...baseAnimalInput, sireId: goat.id }),
      ).rejects.toThrow(`sire '${goat.id}' must be a cattle`);
    });

    it('requires an authenticated actor', async () => {
      await expect(service.registerAnimal(null, baseAnimalInput)).rejects.toThrow(
        'Authentication required for livestock records',
      );
    });

    it('audits and publishes the registration', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'livestock.animal_registered',
          entityType: 'animal',
          entityId: animal.id,
        }),
      );
      const emitted = await outbox.list();
      expect(emitted.some((event) => event.name === 'livestock.animal.registered')).toBe(true);
    });
  });

  describe('ownership-or-admin access control', () => {
    it('lets the owner read their animal', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      const fetched = await service.getAnimal(farmer, animal.id);
      expect(fetched.id).toBe(animal.id);
    });

    it('lets an admin read any animal', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      const fetched = await service.getAnimal(admin, animal.id);
      expect(fetched.id).toBe(animal.id);
    });

    it('denies another farmer reading the animal', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(service.getAnimal(otherFarmer, animal.id)).rejects.toThrow(
        'You may only access your own records',
      );
    });

    it('denies another farmer updating the animal', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(
        service.updateAnimal(otherFarmer, animal.id, { notes: 'tamper' }),
      ).rejects.toThrow('You may only access your own records');
    });

    it('denies anonymous reads', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(service.getAnimal(null, animal.id)).rejects.toThrow(
        'Authentication required for this resource',
      );
    });

    it('throws NotFound for an unknown animal id', async () => {
      await expect(service.getAnimal(farmer, 'NG-BOV-KD-424242')).rejects.toThrow(
        "Resource with id 'NG-BOV-KD-424242' not found",
      );
    });

    it('lists only the animals owned by the caller', async () => {
      await service.registerAnimal(farmer, baseAnimalInput);
      await service.registerAnimal(farmer, baseAnimalInput);
      await service.registerAnimal(otherFarmer, baseAnimalInput);
      const mine = await service.listMyAnimals(farmer, {});
      expect(mine).toHaveLength(2);
      expect(mine.every((animal) => animal.ownerUserId === farmer.id)).toBe(true);
    });

    it('filters owned animals by status', async () => {
      const first = await service.registerAnimal(farmer, baseAnimalInput);
      await service.registerAnimal(farmer, baseAnimalInput);
      await service.updateAnimal(farmer, first.id, { status: 'dead' });
      const alive = await service.listMyAnimals(farmer, { status: 'alive' });
      expect(alive).toHaveLength(1);
    });

    it('filters owned animals by species', async () => {
      await service.registerAnimal(farmer, baseAnimalInput);
      await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        species: 'goat',
        breed: 'Sahel',
      });
      const goats = await service.listMyAnimals(farmer, { species: 'goat' });
      expect(goats).toHaveLength(1);
      expect(goats[0].species).toBe('goat');
    });
  });

  describe('updateAnimal status transitions', () => {
    it('allows alive -> stolen and publishes the change', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      const updated = await service.updateAnimal(farmer, animal.id, { status: 'stolen' });
      expect(updated.status).toBe('stolen');
      const emitted = await outbox.list();
      expect(
        emitted.some(
          (event) =>
            event.name === 'livestock.animal.status_changed' &&
            (event.payload as { to?: string }).to === 'stolen',
        ),
      ).toBe(true);
    });

    it('allows stolen -> alive (recovery)', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.updateAnimal(farmer, animal.id, { status: 'stolen' });
      const recovered = await service.updateAnimal(farmer, animal.id, { status: 'alive' });
      expect(recovered.status).toBe('alive');
    });

    it('treats dead as terminal', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.updateAnimal(farmer, animal.id, { status: 'dead' });
      await expect(
        service.updateAnimal(farmer, animal.id, { status: 'alive' }),
      ).rejects.toThrow(`Animal '${animal.id}' is dead; dead is a terminal status`);
    });

    it('rejects invalid transitions from sold', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.updateAnimal(farmer, animal.id, { status: 'sold' });
      await expect(
        service.updateAnimal(farmer, animal.id, { status: 'alive' }),
      ).rejects.toThrow("Invalid status transition from 'sold' to 'alive'");
    });

    it('does not publish an event when the status is unchanged', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.updateAnimal(farmer, animal.id, { status: 'alive', notes: 'same' });
      const emitted = await outbox.list();
      expect(emitted.some((event) => event.name === 'livestock.animal.status_changed')).toBe(
        false,
      );
    });

    it('validates a patched breed against the species', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(
        service.updateAnimal(farmer, animal.id, { breed: 'Noiler' }),
      ).rejects.toThrow("Unknown cattle breed 'Noiler'");
    });

    it('updates mutable fields', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      const updated = await service.updateAnimal(farmer, animal.id, {
        breed: 'Sokoto Gudali',
        eid: 'EID-NEW',
        notes: 'Re-tagged',
      });
      expect(updated.breed).toBe('Sokoto Gudali');
      expect(updated.eid).toBe('EID-NEW');
      expect(updated.notes).toBe('Re-tagged');
    });
  });

  describe('transferAnimal and transferHistory', () => {
    it('moves ownership to the recipient', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.transferAnimal(farmer, animal.id, {
        toUserId: otherFarmer.id,
        transferType: 'sale',
      });
      const mine = await service.listMyAnimals(farmer, {});
      const theirs = await service.listMyAnimals(otherFarmer, {});
      expect(mine).toHaveLength(0);
      expect(theirs).toHaveLength(1);
      expect(theirs[0].ownerUserId).toBe(otherFarmer.id);
    });

    it('records the transfer ledger row with actor and type', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      const transfer = await service.transferAnimal(farmer, animal.id, {
        toUserId: otherFarmer.id,
        transferType: 'gift',
      });
      expect(transfer.animalId).toBe(animal.id);
      expect(transfer.fromUserId).toBe(farmer.id);
      expect(transfer.toUserId).toBe(otherFarmer.id);
      expect(transfer.transferType).toBe('gift');
      expect(transfer.recordedBy).toBe(farmer.id);
    });

    it('keeps a chronological ownership history across hops', async () => {
      const third: User = asUser({ id: 'farmer-3', roles: ['farmer'] });
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.transferAnimal(farmer, animal.id, {
        toUserId: otherFarmer.id,
        transferType: 'sale',
        effectiveAt: '2026-01-01T00:00:00.000Z',
      });
      await service.transferAnimal(otherFarmer, animal.id, {
        toUserId: third.id,
        transferType: 'aggregation',
        effectiveAt: '2026-02-01T00:00:00.000Z',
      });
      const history = await service.transferHistory(admin, animal.id);
      expect(history).toHaveLength(2);
      expect(history[0].fromUserId).toBe(farmer.id);
      expect(history[0].toUserId).toBe(otherFarmer.id);
      expect(history[1].fromUserId).toBe(otherFarmer.id);
      expect(history[1].toUserId).toBe(third.id);
    });

    it('restricts transfers to the current owner — admins included', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(
        service.transferAnimal(admin, animal.id, {
          toUserId: otherFarmer.id,
          transferType: 'sale',
        }),
      ).rejects.toThrow('Only the current owner can transfer this animal');
    });

    it('rejects transfers of dead animals', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.updateAnimal(farmer, animal.id, { status: 'dead' });
      await expect(
        service.transferAnimal(farmer, animal.id, {
          toUserId: otherFarmer.id,
          transferType: 'sale',
        }),
      ).rejects.toThrow(`Animal '${animal.id}' is dead and cannot be transferred`);
    });

    it('rejects self-transfers', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(
        service.transferAnimal(farmer, animal.id, {
          toUserId: farmer.id,
          transferType: 'gift',
        }),
      ).rejects.toThrow('Cannot transfer an animal to yourself');
    });

    it('audits and publishes the transfer', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await service.transferAnimal(farmer, animal.id, {
        toUserId: otherFarmer.id,
        transferType: 'sale',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'livestock.ownership_transferred',
          entityType: 'animal',
          entityId: animal.id,
        }),
      );
      const emitted = await outbox.list();
      expect(emitted.some((event) => event.name === 'livestock.animal.transferred')).toBe(true);
    });

    it('denies another farmer reading the transfer history', async () => {
      const animal = await service.registerAnimal(farmer, baseAnimalInput);
      await expect(service.transferHistory(otherFarmer, animal.id)).rejects.toThrow(
        'You may only access your own records',
      );
    });
  });

  describe('lots', () => {
    const lotInput = {
      species: 'chicken' as const,
      quantity: 200,
      state: 'Kaduna',
      lga: 'Zaria',
      formationRule: 'same_batch',
    };

    it('issues the lot ID in LOT-{species}-{state}-{serial} format', async () => {
      const lot = await service.createLot(farmer, lotInput);
      expect(lot.id).toBe('LOT-AVI-KD-000001');
      expect(lot.status).toBe('open');
      expect(lot.quantity).toBe(200);
      expect(lot.ownerUserId).toBe(farmer.id);
    });

    it('increments lot serials per species/state', async () => {
      const first = await service.createLot(farmer, lotInput);
      const second = await service.createLot(farmer, lotInput);
      expect(first.id).toBe('LOT-AVI-KD-000001');
      expect(second.id).toBe('LOT-AVI-KD-000002');
    });

    it('rejects a non-positive quantity', async () => {
      await expect(service.createLot(farmer, { ...lotInput, quantity: 0 })).rejects.toThrow(
        'Lot quantity must be a positive integer',
      );
    });

    it('rejects an unknown state', async () => {
      await expect(service.createLot(farmer, { ...lotInput, state: 'Atlantis' })).rejects.toThrow(
        "Unknown Nigerian state 'Atlantis'",
      );
    });

    it('rejects an unsupported species', async () => {
      await expect(
        service.createLot(farmer, { ...lotInput, species: 'camel' as never }),
      ).rejects.toThrow("Unknown livestock species 'camel'");
    });

    it('lists only the lots owned by the caller', async () => {
      await service.createLot(farmer, lotInput);
      await service.createLot(otherFarmer, lotInput);
      const mine = await service.listMyLots(farmer);
      expect(mine).toHaveLength(1);
      expect(mine[0].ownerUserId).toBe(farmer.id);
    });

    it('adds owned animals of the matching species to a lot', async () => {
      const bird = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        species: 'chicken',
        breed: 'Broiler',
      });
      const lot = await service.createLot(farmer, lotInput);
      const updated = await service.updateLotAnimals(farmer, lot.id, { add: [bird.id] });
      expect(updated.animalIds).toContain(bird.id);
    });

    it('rejects adding animals owned by someone else', async () => {
      const bird = await service.registerAnimal(otherFarmer, {
        ...baseAnimalInput,
        species: 'chicken',
        breed: 'Broiler',
      });
      const lot = await service.createLot(farmer, lotInput);
      await expect(
        service.updateLotAnimals(farmer, lot.id, { add: [bird.id] }),
      ).rejects.toThrow(`You may only add your own animals to a lot ('${bird.id}')`);
    });

    it('rejects adding animals of a different species', async () => {
      const cow = await service.registerAnimal(farmer, baseAnimalInput);
      const lot = await service.createLot(farmer, lotInput);
      await expect(service.updateLotAnimals(farmer, lot.id, { add: [cow.id] })).rejects.toThrow(
        `Animal '${cow.id}' is cattle; lot '${lot.id}' is for chicken`,
      );
    });

    it('locks membership once the lot is no longer open', async () => {
      const lot = await service.createLot(farmer, lotInput);
      await lots.update(lot.id, { status: 'closed' });
      await expect(
        service.updateLotAnimals(farmer, lot.id, { add: ['NG-AVI-KD-000001'] }),
      ).rejects.toThrow(`Lot '${lot.id}' is closed; membership is locked`);
    });

    it('removes animals from a lot', async () => {
      const bird = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        species: 'chicken',
        breed: 'Layer',
      });
      const lot = await service.createLot(farmer, lotInput);
      await service.updateLotAnimals(farmer, lot.id, { add: [bird.id] });
      const updated = await service.updateLotAnimals(farmer, lot.id, { remove: [bird.id] });
      expect(updated.animalIds).not.toContain(bird.id);
    });

    it('denies another farmer reading the lot', async () => {
      const lot = await service.createLot(farmer, lotInput);
      await expect(service.getLot(otherFarmer, lot.id)).rejects.toThrow(
        'You may only access your own records',
      );
    });

    it('lets an admin read any lot with its membership', async () => {
      const bird = await service.registerAnimal(farmer, {
        ...baseAnimalInput,
        species: 'chicken',
        breed: 'Noiler',
      });
      const lot = await service.createLot(farmer, lotInput);
      await service.updateLotAnimals(farmer, lot.id, { add: [bird.id] });
      const fetched = await service.getLot(admin, lot.id);
      expect(fetched.animalIds).toEqual([bird.id]);
    });
  });

  describe('pastoralist profiles', () => {
    const profileInput = {
      grazingZoneId: 'zone-kaduna-north',
      migrationPattern: 'transhumant_dry_season_south',
      primarySpecies: ['cattle', 'sheep'] as const,
    };

    it('upserts and reads back a profile (round-trip)', async () => {
      await service.upsertPastoralistProfile(farmer, farmer.id, {
        ...profileInput,
        primarySpecies: [...profileInput.primarySpecies],
      });
      const profile = await service.getPastoralistProfile(farmer, farmer.id);
      expect(profile.userId).toBe(farmer.id);
      expect(profile.grazingZoneId).toBe('zone-kaduna-north');
      expect(profile.migrationPattern).toBe('transhumant_dry_season_south');
      expect(profile.primarySpecies).toEqual(['cattle', 'sheep']);
    });

    it('overwrites an existing profile on re-upsert', async () => {
      await service.upsertPastoralistProfile(farmer, farmer.id, {
        ...profileInput,
        primarySpecies: ['cattle'],
      });
      await service.upsertPastoralistProfile(farmer, farmer.id, {
        ...profileInput,
        primarySpecies: ['goat'],
      });
      const profile = await service.getPastoralistProfile(farmer, farmer.id);
      expect(profile.primarySpecies).toEqual(['goat']);
    });

    it('validates every primary species', async () => {
      await expect(
        service.upsertPastoralistProfile(farmer, farmer.id, {
          ...profileInput,
          primarySpecies: ['cattle', 'camel' as never],
        }),
      ).rejects.toThrow("Unknown livestock species 'camel'");
    });

    it('lets an admin manage another user profile', async () => {
      await service.upsertPastoralistProfile(admin, farmer.id, {
        ...profileInput,
        primarySpecies: ['cattle'],
      });
      const profile = await service.getPastoralistProfile(admin, farmer.id);
      expect(profile.userId).toBe(farmer.id);
    });

    it('denies writing another user profile without admin', async () => {
      await expect(
        service.upsertPastoralistProfile(otherFarmer, farmer.id, {
          ...profileInput,
          primarySpecies: ['cattle'],
        }),
      ).rejects.toThrow('You may only access your own records');
    });

    it('throws NotFound when no profile exists yet', async () => {
      await expect(service.getPastoralistProfile(farmer, farmer.id)).rejects.toThrow(
        `No pastoralist profile recorded for user '${farmer.id}' yet`,
      );
    });

    it('publishes the profile-updated event', async () => {
      await service.upsertPastoralistProfile(farmer, farmer.id, {
        ...profileInput,
        primarySpecies: ['cattle'],
      });
      const emitted = await outbox.list();
      expect(
        emitted.some((event) => event.name === 'livestock.pastoralist_profile.updated'),
      ).toBe(true);
    });
  });
});
