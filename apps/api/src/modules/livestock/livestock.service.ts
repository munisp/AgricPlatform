import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import type {
  Animal,
  AnimalStatus,
  LivestockLot,
  LivestockSpecies,
  OwnershipTransfer,
  OwnershipTransferType,
  PastoralistProfile,
  User
} from '@agric-platform/shared';
import {
  formatAnimalId,
  formatLotId,
  LIVESTOCK_BREEDS,
  LIVESTOCK_CONSENT_DOMAIN,
  LIVESTOCK_SPECIES,
  NIGERIAN_STATE_CODES
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  LIVESTOCK_TRANSFER_GUARD,
  LOT_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY,
  PASTORALIST_PROFILE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalCriteria,
  AnimalRepository,
  LotRepository,
  OwnershipTransferRepository,
  PastoralistProfileRepository
} from '../../database/repositories/livestock.repository.js';
import type { LivestockTransferGuard } from '../../database/repositories/livestock-trade.repository.js';
import { PrivacyService } from '../privacy/privacy.service.js';
import { UsersService } from '../users/users.service.js';

export interface RegisterAnimalInput {
  species: LivestockSpecies;
  breed: string;
  sex: Animal['sex'];
  birthDate?: string;
  tagId?: string;
  eid?: string;
  state: string;
  lga?: string;
  sireId?: string;
  damId?: string;
  notes?: string;
}

export interface UpdateAnimalInput {
  breed?: string;
  notes?: string;
  eid?: string;
  status?: AnimalStatus;
}

export interface TransferAnimalInput {
  toUserId: string;
  transferType: OwnershipTransferType;
  effectiveAt?: string;
}

export interface CreateLotInput {
  species: LivestockSpecies;
  quantity: number;
  state: string;
  lga?: string;
  formationRule?: string;
}

export interface PastoralistProfileInput {
  grazingZoneId?: string;
  migrationPattern?: string;
  primarySpecies: LivestockSpecies[];
}

export interface EnrolmentResult {
  userId: string;
  /** True when the farmer role marker had to be added by this call. */
  roleBound: boolean;
  consentId: string;
  alreadyEnrolled: boolean;
}

/**
 * Status transition rules (blueprint F1.3): death is terminal; a stolen
 * animal can be recovered (back to alive) or confirmed dead; a sold animal
 * can only be closed out as dead — a change of hands after a sale is an
 * ownership transfer, not a status flip.
 */
export const ANIMAL_STATUS_TRANSITIONS: Record<AnimalStatus, readonly AnimalStatus[]> = {
  alive: ['sold', 'dead', 'stolen'],
  stolen: ['alive', 'dead'],
  sold: ['dead'],
  dead: []
};

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for livestock records');
  }
  return actor;
}

@Injectable()
export class LivestockService {
  constructor(
    private readonly users: UsersService,
    private readonly privacy: PrivacyService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(OWNERSHIP_TRANSFER_REPOSITORY)
    private readonly transfers: OwnershipTransferRepository,
    @Inject(PASTORALIST_PROFILE_REPOSITORY)
    private readonly pastoralists: PastoralistProfileRepository,
    /**
     * Optional transfer guard port (wave L1c): when bound (lien-backed
     * implementation registered by the DatabaseModule), transferAnimal
     * consults it before committing. Optional so the livestock core never
     * imports the trade module — no circular dependency.
     */
    @Optional()
    @Inject(LIVESTOCK_TRANSFER_GUARD)
    private readonly transferGuard?: LivestockTransferGuard
  ) {}

  /**
   * Enrols a farmer into the livestock domain: binds the farmer role marker
   * and captures per-domain consent ('livestock_records') through the
   * privacy consent service. Idempotent — re-enrolment replays the existing
   * consent and leaves roles untouched.
   */
  async enrol(actor: User | null, userId: string): Promise<EnrolmentResult> {
    assertSelfOrAdmin(actor, userId);
    const user = await this.users.getById(userId);
    let roleBound = false;
    if (!user.roles.includes('farmer')) {
      await this.users.setRoles(userId, [...user.roles, 'farmer']);
      roleBound = true;
    }
    const existing = (await this.privacy.consentsFor(userId)).find(
      (consent) =>
        consent.purpose === LIVESTOCK_CONSENT_DOMAIN && consent.granted && !consent.revokedAt
    );
    const consent =
      existing ??
      (await this.privacy.grantConsent({
        userId,
        purpose: LIVESTOCK_CONSENT_DOMAIN,
        granted: true,
        source: 'livestock_enrolment'
      }));
    const alreadyEnrolled = Boolean(existing) && !roleBound;
    await this.audit.record({
      actorId: actor!.id,
      action: 'livestock.enrolment_completed',
      entityType: 'user',
      entityId: userId,
      metadata: { consentId: consent.id, roleBound }
    });
    await this.events.publish(
      'livestock.enrolment.completed',
      { userId, consentId: consent.id },
      actor!.id
    );
    return { userId, roleBound, consentId: consent.id, alreadyEnrolled };
  }

  /** Registers an animal and issues its national ID from the serial counter. */
  async registerAnimal(actor: User | null, input: RegisterAnimalInput): Promise<Animal> {
    const owner = requireActor(actor);
    this.assertValidSpeciesAndBreed(input.species, input.breed);
    this.assertValidState(input.state);
    if (input.sireId) {
      await this.assertParent(input.sireId, input.species, 'sire');
    }
    if (input.damId) {
      await this.assertParent(input.damId, input.species, 'dam');
    }
    const serial = await this.animals.nextSerial(input.species, input.state);
    const now = new Date().toISOString();
    const animal: Animal = {
      id: formatAnimalId(input.species, input.state, serial),
      species: input.species,
      breed: input.breed,
      sex: input.sex,
      birthDate: input.birthDate,
      tagId: input.tagId,
      eid: input.eid,
      ownerUserId: owner.id,
      state: input.state,
      lga: input.lga,
      status: 'alive',
      sireId: input.sireId,
      damId: input.damId,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.animals.create(animal);
    await this.audit.record({
      actorId: owner.id,
      action: 'livestock.animal_registered',
      entityType: 'animal',
      entityId: created.id,
      metadata: { species: created.species, state: created.state }
    });
    await this.events.publish(
      'livestock.animal.registered',
      { animalId: created.id, species: created.species, ownerUserId: owner.id },
      owner.id
    );
    return created;
  }

  async listMyAnimals(
    actor: User | null,
    filter: Pick<AnimalCriteria, 'species' | 'status' | 'state'>
  ): Promise<Animal[]> {
    const owner = requireActor(actor);
    return this.animals.find({ ownerUserId: owner.id, ...filter });
  }

  async getAnimal(actor: User | null, id: string): Promise<Animal> {
    const animal = await this.animals.getById(id);
    assertSelfOrAdmin(actor, animal.ownerUserId);
    return animal;
  }

  /** Owner-or-admin update; status transitions follow ANIMAL_STATUS_TRANSITIONS. */
  async updateAnimal(actor: User | null, id: string, patch: UpdateAnimalInput): Promise<Animal> {
    const animal = await this.animals.getById(id);
    assertSelfOrAdmin(actor, animal.ownerUserId);
    if (patch.breed !== undefined) {
      this.assertValidSpeciesAndBreed(animal.species, patch.breed);
    }
    if (patch.status !== undefined && patch.status !== animal.status) {
      const allowed = ANIMAL_STATUS_TRANSITIONS[animal.status];
      if (!allowed.includes(patch.status)) {
        throw new BadRequestException(
          animal.status === 'dead'
            ? `Animal '${id}' is dead; dead is a terminal status`
            : `Invalid status transition from '${animal.status}' to '${patch.status}'`
        );
      }
    }
    const updated = await this.animals.update(id, {
      ...patch,
      updatedAt: new Date().toISOString()
    });
    if (patch.status !== undefined && patch.status !== animal.status) {
      await this.events.publish(
        'livestock.animal.status_changed',
        { animalId: id, from: animal.status, to: patch.status },
        actor!.id
      );
    }
    return updated;
  }

  /**
   * Ownership transfer (owner-only — admins use programme tooling, not this
   * endpoint). The ledger row and the owner update commit atomically.
   */
  async transferAnimal(
    actor: User | null,
    id: string,
    input: TransferAnimalInput
  ): Promise<OwnershipTransfer> {
    const owner = requireActor(actor);
    const animal = await this.animals.getById(id);
    if (animal.ownerUserId !== owner.id) {
      throw new ForbiddenException('Only the current owner can transfer this animal');
    }
    if (animal.status === 'dead') {
      throw new BadRequestException(`Animal '${id}' is dead and cannot be transferred`);
    }
    if (input.toUserId === owner.id) {
      throw new BadRequestException('Cannot transfer an animal to yourself');
    }
    // Wave L1c integration point: an animal with an active lien cannot be
    // transferred or sold (guard is a no-op when unbound).
    if (this.transferGuard) {
      await this.transferGuard.assertTransferable(id);
    }
    await this.users.getById(input.toUserId); // 404 for unknown recipients
    const now = new Date().toISOString();
    const transfer: OwnershipTransfer = {
      id: newId('transfer'),
      animalId: id,
      fromUserId: owner.id,
      toUserId: input.toUserId,
      transferType: input.transferType,
      effectiveAt: input.effectiveAt ?? now,
      recordedBy: owner.id,
      createdAt: now
    };
    await this.animals.transferOwnership(transfer);
    await this.audit.record({
      actorId: owner.id,
      action: 'livestock.ownership_transferred',
      entityType: 'animal',
      entityId: id,
      metadata: {
        transferId: transfer.id,
        toUserId: input.toUserId,
        transferType: input.transferType
      }
    });
    await this.events.publish(
      'livestock.animal.transferred',
      { animalId: id, transferId: transfer.id, fromUserId: owner.id, toUserId: input.toUserId },
      owner.id
    );
    return transfer;
  }

  async transferHistory(actor: User | null, id: string): Promise<OwnershipTransfer[]> {
    const animal = await this.animals.getById(id);
    assertSelfOrAdmin(actor, animal.ownerUserId);
    const history = await this.transfers.find({ animalId: id });
    return history.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Creates a group lot (flock/pen/herd) and issues its lot ID. */
  async createLot(actor: User | null, input: CreateLotInput): Promise<LivestockLot> {
    const owner = requireActor(actor);
    this.assertValidSpecies(input.species);
    this.assertValidState(input.state);
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new BadRequestException('Lot quantity must be a positive integer');
    }
    const serial = await this.lots.nextLotSerial(input.species, input.state);
    const now = new Date().toISOString();
    const lot: LivestockLot = {
      id: formatLotId(input.species, input.state, serial),
      species: input.species,
      quantity: input.quantity,
      ownerUserId: owner.id,
      state: input.state,
      lga: input.lga,
      formationRule: input.formationRule,
      status: 'open',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.lots.create(lot);
    await this.events.publish(
      'livestock.lot.created',
      { lotId: created.id, species: created.species, ownerUserId: owner.id },
      owner.id
    );
    return created;
  }

  async listMyLots(actor: User | null): Promise<LivestockLot[]> {
    const owner = requireActor(actor);
    return this.lots.find({ ownerUserId: owner.id });
  }

  async getLot(actor: User | null, id: string): Promise<LivestockLot & { animalIds: string[] }> {
    const lot = await this.lots.getById(id);
    assertSelfOrAdmin(actor, lot.ownerUserId);
    return { ...lot, animalIds: await this.lots.listAnimalIds(id) };
  }

  /**
   * Adds/removes member animals. The caller must own the lot (or be an
   * admin) AND own every animal added; animals must match the lot species
   * and the lot must still be open.
   */
  async updateLotAnimals(
    actor: User | null,
    lotId: string,
    change: { add?: string[]; remove?: string[] }
  ): Promise<LivestockLot & { animalIds: string[] }> {
    const caller = requireActor(actor);
    const lot = await this.lots.getById(lotId);
    assertSelfOrAdmin(caller, lot.ownerUserId);
    if (lot.status !== 'open') {
      throw new BadRequestException(`Lot '${lotId}' is ${lot.status}; membership is locked`);
    }
    for (const animalId of change.add ?? []) {
      const animal = await this.animals.getById(animalId);
      if (animal.ownerUserId !== caller.id) {
        throw new ForbiddenException(`You may only add your own animals to a lot ('${animalId}')`);
      }
      if (animal.species !== lot.species) {
        throw new BadRequestException(
          `Animal '${animalId}' is ${animal.species}; lot '${lotId}' is for ${lot.species}`
        );
      }
      await this.lots.addAnimal(lotId, animalId);
    }
    for (const animalId of change.remove ?? []) {
      await this.lots.removeAnimal(lotId, animalId);
    }
    return { ...lot, animalIds: await this.lots.listAnimalIds(lotId) };
  }

  async getPastoralistProfile(actor: User | null, userId: string): Promise<PastoralistProfile> {
    assertSelfOrAdmin(actor, userId);
    const profile = await this.pastoralists.findByUserId(userId);
    if (!profile) {
      throw new NotFoundException(`No pastoralist profile recorded for user '${userId}' yet`);
    }
    return profile;
  }

  async upsertPastoralistProfile(
    actor: User | null,
    userId: string,
    input: PastoralistProfileInput
  ): Promise<PastoralistProfile> {
    assertSelfOrAdmin(actor, userId);
    await this.users.getById(userId);
    for (const species of input.primarySpecies) {
      this.assertValidSpecies(species);
    }
    const profile: PastoralistProfile = {
      userId,
      grazingZoneId: input.grazingZoneId,
      migrationPattern: input.migrationPattern,
      primarySpecies: input.primarySpecies,
      updatedAt: new Date().toISOString()
    };
    await this.pastoralists.upsert(profile);
    await this.events.publish(
      'livestock.pastoralist_profile.updated',
      { userId, primarySpecies: profile.primarySpecies },
      actor!.id
    );
    return profile;
  }

  private assertValidSpecies(species: string): asserts species is LivestockSpecies {
    if (!(LIVESTOCK_SPECIES as readonly string[]).includes(species)) {
      throw new BadRequestException(
        `Unknown livestock species '${species}'. Expected one of: ${LIVESTOCK_SPECIES.join(', ')}`
      );
    }
  }

  private assertValidSpeciesAndBreed(species: string, breed: string): void {
    this.assertValidSpecies(species);
    const breeds = LIVESTOCK_BREEDS[species as LivestockSpecies];
    if (!breeds.includes(breed)) {
      throw new BadRequestException(
        `Unknown ${species} breed '${breed}'. Expected one of: ${breeds.join(', ')}`
      );
    }
  }

  private assertValidState(state: string): void {
    if (!NIGERIAN_STATE_CODES[state]) {
      throw new BadRequestException(`Unknown Nigerian state '${state}'`);
    }
  }

  private async assertParent(
    parentId: string,
    species: LivestockSpecies,
    role: 'sire' | 'dam'
  ): Promise<void> {
    const parent = await this.animals.findById(parentId);
    if (!parent) {
      throw new BadRequestException(`${role} '${parentId}' is not a registered animal`);
    }
    if (parent.species !== species) {
      throw new BadRequestException(`${role} '${parentId}' must be a ${species}`);
    }
  }
}
