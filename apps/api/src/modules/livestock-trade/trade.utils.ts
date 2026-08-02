import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException
} from '@nestjs/common';
import type {
  LivestockSubjectType,
  User,
  UserRole
} from '@agric-platform/shared';
import type { AnimalRepository, LotRepository } from '../../database/repositories/livestock.repository.js';

/** Shared helpers for the ALTP wave-L1c trade/finance services. */

export function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for livestock trade records');
  }
  return actor;
}

/** Requires one of the given roles (admin always satisfies the check). */
export function assertRole(actor: User | null, roles: readonly UserRole[]): User {
  const caller = requireActor(actor);
  if (caller.roles.includes('admin') || roles.some((role) => caller.roles.includes(role))) {
    return caller;
  }
  throw new ForbiddenException(`Requires one of roles: ${roles.join(', ')}`);
}

/** Money is integer kobo; never floats. */
export function assertKobo(value: number, field: string, { allowZero = false } = {}): void {
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new BadRequestException(
      `${field} must be a ${allowZero ? 'non-negative' : 'positive'} integer (kobo)`
    );
  }
}

/** Resolved registry subject (animal or lot) used across trade/finance flows. */
export interface SubjectSnapshot {
  subjectType: LivestockSubjectType;
  subjectId: string;
  species: string;
  breed?: string;
  quantity?: number;
  ownerUserId: string;
  state: string;
  lga?: string;
}

/** Loads an animal or lot from the livestock registry (404 when missing). */
export async function resolveSubject(
  animals: Pick<AnimalRepository, 'getById'>,
  lots: Pick<LotRepository, 'getById'>,
  subjectType: LivestockSubjectType,
  subjectId: string
): Promise<SubjectSnapshot> {
  if (subjectType === 'animal') {
    const animal = await animals.getById(subjectId);
    return {
      subjectType,
      subjectId,
      species: animal.species,
      breed: animal.breed,
      ownerUserId: animal.ownerUserId,
      state: animal.state,
      lga: animal.lga
    };
  }
  const lot = await lots.getById(subjectId);
  return {
    subjectType,
    subjectId,
    species: lot.species,
    quantity: lot.quantity,
    ownerUserId: lot.ownerUserId,
    state: lot.state,
    lga: lot.lga
  };
}
