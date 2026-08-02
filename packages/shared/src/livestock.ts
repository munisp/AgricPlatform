/**
 * Africa Livestock Trust Platform (ALTP) domain primitives — wave L1a.
 * Species codes drive the national animal ID format
 * (NG-{SPECIES_CODE}-{STATE_CODE}-{6-digit serial}); state codes use the
 * conventional two-letter Nigerian abbreviations.
 */

export const LIVESTOCK_SPECIES = ['cattle', 'sheep', 'goat', 'chicken', 'pig'] as const;
export type LivestockSpecies = (typeof LIVESTOCK_SPECIES)[number];

export const LIVESTOCK_SPECIES_CODES: Record<LivestockSpecies, string> = {
  cattle: 'BOV',
  sheep: 'OVI',
  goat: 'CAP',
  chicken: 'AVI',
  pig: 'SUS'
};

export const ANIMAL_STATUSES = ['alive', 'sold', 'dead', 'stolen'] as const;
export type AnimalStatus = (typeof ANIMAL_STATUSES)[number];

export const ANIMAL_SEXES = ['male', 'female'] as const;
export type AnimalSex = (typeof ANIMAL_SEXES)[number];

export const LOT_STATUSES = ['open', 'closed', 'sold'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export const OWNERSHIP_TRANSFER_TYPES = ['sale', 'gift', 'programme', 'aggregation'] as const;
export type OwnershipTransferType = (typeof OWNERSHIP_TRANSFER_TYPES)[number];

/** Consent purpose recorded at livestock enrolment (privacy module domain). */
export const LIVESTOCK_CONSENT_DOMAIN = 'livestock_records';

/**
 * Nigerian breed fixtures per species (foundation set — the registry is
 * expected to grow; registration validates against this list).
 */
export const LIVESTOCK_BREEDS: Record<LivestockSpecies, readonly string[]> = {
  cattle: ['White Fulani', 'Red Bororo', 'Sokoto Gudali', 'Muturu'],
  sheep: ['Yankasa', 'Balami', 'Uda'],
  goat: ['West African Dwarf', 'Sahel', 'Red Sokoto'],
  chicken: ['Broiler', 'Layer', 'Noiler'],
  pig: ['Large White', 'Landrace', 'Duroc']
};

/** Two-letter state codes used inside animal/lot IDs (keyed by state name). */
export const NIGERIAN_STATE_CODES: Record<string, string> = {
  Abia: 'AB',
  Adamawa: 'AD',
  'Akwa Ibom': 'AK',
  Anambra: 'AN',
  Bauchi: 'BA',
  Bayelsa: 'BY',
  Benue: 'BE',
  Borno: 'BO',
  'Cross River': 'CR',
  Delta: 'DE',
  Ebonyi: 'EB',
  Edo: 'ED',
  Ekiti: 'EK',
  Enugu: 'EN',
  FCT: 'FC',
  Gombe: 'GO',
  Imo: 'IM',
  Jigawa: 'JI',
  Kaduna: 'KD',
  Kano: 'KN',
  Katsina: 'KT',
  Kebbi: 'KB',
  Kogi: 'KG',
  Kwara: 'KW',
  Lagos: 'LA',
  Nasarawa: 'NA',
  Niger: 'NI',
  Ogun: 'OG',
  Ondo: 'ON',
  Osun: 'OS',
  Oyo: 'OY',
  Plateau: 'PL',
  Rivers: 'RI',
  Sokoto: 'SO',
  Taraba: 'TA',
  Yobe: 'YO',
  Zamfara: 'ZA'
};

/** Composes the national animal ID: NG-{SPECIES}-{STATE}-{6-digit serial}. */
export function formatAnimalId(species: LivestockSpecies, state: string, serial: number): string {
  const speciesCode = LIVESTOCK_SPECIES_CODES[species];
  const stateCode = NIGERIAN_STATE_CODES[state];
  return `NG-${speciesCode}-${stateCode}-${String(serial).padStart(6, '0')}`;
}

/** Composes a lot ID: LOT-{SPECIES}-{STATE}-{6-digit serial}. */
export function formatLotId(species: LivestockSpecies, state: string, serial: number): string {
  const speciesCode = LIVESTOCK_SPECIES_CODES[species];
  const stateCode = NIGERIAN_STATE_CODES[state];
  return `LOT-${speciesCode}-${stateCode}-${String(serial).padStart(6, '0')}`;
}

export interface Animal {
  /** National animal ID, e.g. NG-BOV-KD-000123. */
  id: string;
  species: LivestockSpecies;
  breed: string;
  sex: AnimalSex;
  birthDate?: string;
  /** Visual ear tag; unique across the registry when present. */
  tagId?: string;
  /** Electronic ID (RFID), nullable. */
  eid?: string;
  ownerUserId: string;
  /** Nigerian state name (ID embeds the two-letter code). */
  state: string;
  lga?: string;
  status: AnimalStatus;
  sireId?: string;
  damId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** Group of animals managed together (e.g. a poultry flock or pig pen). */
export interface LivestockLot {
  /** Lot ID, e.g. LOT-AVI-KD-000007. */
  id: string;
  species: LivestockSpecies;
  quantity: number;
  ownerUserId: string;
  state: string;
  lga?: string;
  formationRule?: string;
  status: LotStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OwnershipTransfer {
  id: string;
  animalId: string;
  fromUserId: string;
  toUserId: string;
  transferType: OwnershipTransferType;
  effectiveAt: string;
  recordedBy: string;
  createdAt: string;
}

/** Pastoralist-specific profile extension (grazing/migration metadata). */
export interface PastoralistProfile {
  userId: string;
  grazingZoneId?: string;
  migrationPattern?: string;
  primarySpecies: LivestockSpecies[];
  updatedAt: string;
}
