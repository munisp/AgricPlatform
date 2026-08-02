import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Animal, OwnershipTransfer, User } from '@agric-platform/shared';
import {
  ANIMAL_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  OwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import { CsvBuilder } from './csv.js';
import { requireActor } from './trade.utils.js';

export interface ComplianceExportFilter {
  /** Nigerian state name; limits the export to animals registered there. */
  state?: string;
  /** ISO timestamp lower bound (inclusive) on record timestamps. */
  from?: string;
  /** ISO timestamp upper bound (inclusive) on record timestamps. */
  to?: string;
}

/** Deterministic column ordering per section (blueprint F6). */
export const COMPLIANCE_ANIMAL_COLUMNS = [
  'animal_id',
  'species',
  'breed',
  'sex',
  'owner_user_id',
  'state',
  'lga',
  'status',
  'created_at'
] as const;

export const COMPLIANCE_TRANSFER_COLUMNS = [
  'id',
  'animal_id',
  'from_user_id',
  'to_user_id',
  'transfer_type',
  'effective_at',
  'recorded_by',
  'created_at'
] as const;

/** Placeholder columns for the L1b health wave; zero rows until it lands. */
export const COMPLIANCE_HEALTH_COLUMNS = [
  'animal_id',
  'recorded_at',
  'record_type',
  'summary'
] as const;

export const COMPLIANCE_MOVEMENT_COLUMNS = [
  'id',
  'animal_id',
  'from_state',
  'to_state',
  'moved_at'
] as const;

function inRange(timestamp: string, from?: string, to?: string): boolean {
  if (from && timestamp < from) {
    return false;
  }
  if (to && timestamp > to) {
    return false;
  }
  return true;
}

/**
 * Regulator compliance export (F6): a sectioned CSV of registry animals
 * and ownership transfers, plus placeholder-tolerant health/movement
 * sections that carry only headers until the L1b health wave lands.
 * Regulator (or admin) role gate; deterministic column ordering.
 */
@Injectable()
export class ComplianceService {
  constructor(
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(OWNERSHIP_TRANSFER_REPOSITORY)
    private readonly transfers: OwnershipTransferRepository
  ) {}

  async exportCsv(actor: User | null, filter: ComplianceExportFilter): Promise<string> {
    const caller = requireActor(actor);
    if (!caller.roles.includes('regulator') && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only a regulator (or admin) can export compliance data');
    }
    const csv = new CsvBuilder();

    // Section: animals.
    csv.row(['section', 'animals']);
    csv.row(COMPLIANCE_ANIMAL_COLUMNS);
    const animals = (await this.animals.find({ state: filter.state }))
      .filter((animal: Animal) => inRange(animal.createdAt, filter.from, filter.to))
      .sort((a: Animal, b: Animal) => a.id.localeCompare(b.id));
    const animalStateById = new Map<string, string>();
    for (const animal of animals) {
      animalStateById.set(animal.id, animal.state);
      csv.row([
        animal.id,
        animal.species,
        animal.breed,
        animal.sex,
        animal.ownerUserId,
        animal.state,
        animal.lga,
        animal.status,
        animal.createdAt
      ]);
    }

    // Section: ownership transfers (limited to exported animals so the
    // state filter applies transitively).
    csv.row(['section', 'ownership_transfers']);
    csv.row(COMPLIANCE_TRANSFER_COLUMNS);
    const transfers = (await this.transfers.all())
      .filter(
        (transfer: OwnershipTransfer) =>
          animalStateById.has(transfer.animalId) &&
          inRange(transfer.effectiveAt, filter.from, filter.to)
      )
      .sort((a: OwnershipTransfer, b: OwnershipTransfer) => a.id.localeCompare(b.id));
    for (const transfer of transfers) {
      csv.row([
        transfer.id,
        transfer.animalId,
        transfer.fromUserId,
        transfer.toUserId,
        transfer.transferType,
        transfer.effectiveAt,
        transfer.recordedBy,
        transfer.createdAt
      ]);
    }

    // Sections: health records + movements. Placeholder-tolerant — headers
    // only until the L1b health/movement wave lands its data sources.
    csv.row(['section', 'health_records']);
    csv.row(COMPLIANCE_HEALTH_COLUMNS);
    csv.row(['section', 'movements']);
    csv.row(COMPLIANCE_MOVEMENT_COLUMNS);

    return csv.toString();
  }
}
