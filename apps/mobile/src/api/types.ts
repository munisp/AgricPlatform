/**
 * Minimal domain types for the mobile shell — mirrors the shared package
 * shapes (packages/shared) but stays self-contained so the mobile workspace
 * typechecks standalone in CI.
 */

export interface User {
  id: string;
  phone: string;
  fullName: string;
  roles: string[];
  preferredLanguage: 'en' | 'ha' | 'yo' | 'ig';
}

export interface Course {
  id: string;
  title: string;
  category: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  durationMinutes: number;
  language: string;
  enrolmentCount: number;
  offlineAvailable: boolean;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  kind: 'produce' | 'input' | 'service' | 'equipment' | 'storage' | 'transport';
  title: string;
  crop?: string;
  quantity: number;
  unit: string;
  priceNaira: number;
  location: { state: string; lga?: string };
  harvestDate?: string;
  isActive: boolean;
}

export interface Opportunity {
  id: string;
  title: string;
  type: string;
  deadline: string;
  isActive: boolean;
}

export interface WeatherSnapshot {
  state: string;
  temperatureCelsius: number;
  humidityPercent: number;
  rainfallMm: number;
  outlook: string;
  source: string;
}

/** Own pathway enrolment summary from GET /pathway-enrolments/mine. */
export interface MyPathwayEnrolmentSummary {
  enrolment: { id: string; templateId: string; status: string };
  template: { id: string; name: string };
  stagesTotal: number;
  stagesCompleted: number;
  currentStageTitle?: string;
}

/* ------------------------------- orders -------------------------------- */

export const ORDER_STATUSES = [
  'placed',
  'deposit_paid',
  'in_fulfilment',
  'delivered',
  'completed',
  'disputed',
  'cancelled'
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Order shape from GET /orders and GET /orders/:id. */
export interface Order {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  quantity: number;
  totalNaira: number;
  status: OrderStatus;
  escrowRequired: boolean;
  createdAt: string;
}

export type DraftOrderStatus = 'open' | 'confirmed' | 'discarded';

/** Draft order from GET /draft-orders (Wave M agent-created orders). */
export interface DraftOrder {
  id: string;
  listingId: string;
  variantId?: string;
  buyerId: string;
  sellerId: string;
  quantity: number;
  unitPriceKobo: number;
  status: DraftOrderStatus;
  orderId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------------------------- notifications ----------------------------- */

/** Notification message from GET /notifications?userId=… */
export interface NotificationMessage {
  id: string;
  userId: string;
  channel: 'in_app' | 'sms' | 'whatsapp' | 'email' | 'push';
  title: string;
  body: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'read';
  createdAt: string;
}

/* ------------------------------ livestock ------------------------------- */

export type LivestockSpecies = 'cattle' | 'sheep' | 'goat' | 'chicken' | 'pig';
export type AnimalSex = 'male' | 'female';

/** Registered animal from GET /livestock/animals/mine. */
export interface Animal {
  /** National animal ID, e.g. NG-BOV-KD-000123. */
  id: string;
  species: LivestockSpecies;
  breed: string;
  sex: AnimalSex;
  birthDate?: string;
  tagId?: string;
  eid?: string;
  ownerUserId: string;
  state: string;
  lga?: string;
  status: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** Minimal registration payload for POST /livestock/animals. */
export interface RegisterAnimalInput {
  species: LivestockSpecies;
  breed: string;
  sex: AnimalSex;
  state: string;
  birthDate?: string;
  tagId?: string;
  notes?: string;
}

/** Disease recall from GET /livestock-health/recalls (regulator/admin only). */
export interface HealthRecall {
  id: string;
  status: string;
  reason?: string;
  createdAt: string;
}

/** Vaccination due status from GET /livestock-health/vaccinations/due. */
export type VaccinationDueStatus = 'overdue' | 'due' | 'upcoming';

/**
 * One computed due-vaccination row from GET /livestock-health/vaccinations/due.
 * `daysOverdue` is set when status is 'overdue'; `daysUntilDue` when 'due'
 * (inside the lookahead window) or 'upcoming' (beyond it).
 */
export interface VaccinationDueItem {
  animalId: string;
  vaccine: string;
  dueDate: string;
  lastAdministeredAt?: string;
  daysOverdue?: number;
  daysUntilDue?: number;
  status: VaccinationDueStatus;
}

export interface ApiListResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------- farms (farms wave) -------------------------- */

/** Farm plot — mirrors packages/shared farms.ts (kept self-contained). */
export interface FarmPlot {
  id: string;
  ownerUserId: string;
  name: string;
  state: string;
  lga: string;
  centroidLat: number;
  centroidLong: number;
  boundaryGeojson?: unknown;
  sizeHectares: number;
  soilType?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  clientId?: string;
}

export interface CreateFarmPlotInput {
  name: string;
  state: string;
  lga: string;
  centroidLat: number;
  centroidLong: number;
  boundaryGeojson?: unknown;
  sizeHectares: number;
  soilType?: string;
  clientId?: string;
}
