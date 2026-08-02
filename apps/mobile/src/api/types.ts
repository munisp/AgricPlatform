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

export interface ApiListResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
