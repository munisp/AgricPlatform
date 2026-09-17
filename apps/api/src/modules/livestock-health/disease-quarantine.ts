import { ConflictException } from '@nestjs/common';
import type { Animal, DiseaseFlag, LivestockSpecies } from '@agric-platform/shared';

/**
 * V-12 quarantine gating (dim04-J2): a CONFIRMED disease flag closes the
 * origin state for movement permits and blocks ownership transfers of
 * matching animals while the flag is inside its quarantine window.
 *
 * The flag model carries no explicit end date (flags are surveillance
 * records, retracted only as false positives), so the window is derived from
 * the last state transition (`updatedAt`, i.e. confirmation time): a
 * confirmed flag quarantines its state for DISEASE_QUARANTINE_WINDOW_DAYS.
 * 30 days covers the incubation + surveillance period of the priority
 * transboundary diseases on the Nigerian roster (FMD 14d, CBPP 21d,
 * anthrax ~20d) with margin; per-disease refinement is a design item for
 * the veterinary-authority integration (E-04).
 */
export const DISEASE_QUARANTINE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** True while the confirmed flag's quarantine window is still open at `now`. */
export function isInQuarantineWindow(flag: DiseaseFlag, now: Date = new Date()): boolean {
  if (flag.status !== 'confirmed') {
    return false;
  }
  const confirmedAt = Date.parse(flag.updatedAt);
  if (Number.isNaN(confirmedAt)) {
    return true; // fail closed on a corrupt timestamp
  }
  return confirmedAt + DISEASE_QUARANTINE_WINDOW_DAYS * DAY_MS > now.getTime();
}

/** A flag without a species restriction applies to every species. */
export function flagAppliesToSpecies(flag: DiseaseFlag, species: LivestockSpecies): boolean {
  return flag.suspectedSpecies === undefined || flag.suspectedSpecies === species;
}

/**
 * Confirmed, in-window flags for `state` that apply to ANY of the given
 * species (an empty species list matches any flag in the state).
 */
export function activeQuarantineFlags(
  flags: readonly DiseaseFlag[],
  state: string,
  species: readonly LivestockSpecies[],
  now: Date = new Date()
): DiseaseFlag[] {
  return flags.filter(
    (flag) =>
      flag.state === state &&
      isInQuarantineWindow(flag, now) &&
      (species.length === 0 || species.some((candidate) => flagAppliesToSpecies(flag, candidate)))
  );
}

/**
 * Transfer guard implementation (same port shape as the lien transfer
 * guard): blocks a transfer when the animal's home state is under an active
 * quarantine for its species. Fail-closed 409.
 */
export function createDiseaseTransferGuard(
  diseaseFlags: {
    find(criteria: { status?: DiseaseFlag['status']; state?: string }): Promise<DiseaseFlag[]>;
  },
  animals: { getById(id: string): Promise<Animal> }
): { assertTransferable(animalId: string): Promise<void> } {
  return {
    async assertTransferable(animalId: string): Promise<void> {
      const animal = await animals.getById(animalId);
      const confirmed = await diseaseFlags.find({ status: 'confirmed', state: animal.state });
      const blocking = activeQuarantineFlags(confirmed, animal.state, [animal.species]);
      if (blocking.length > 0) {
        const flag = blocking[0];
        throw new ConflictException(
          `Animal '${animalId}' cannot be transferred: confirmed ${flag.disease} quarantine ` +
            `in ${flag.state} (flag '${flag.id}', window ${DISEASE_QUARANTINE_WINDOW_DAYS} days)`
        );
      }
    }
  };
}
