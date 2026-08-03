import type { GeoCreditShadowScore } from '@agric-platform/shared';

/**
 * Geo-verified credit shadow-score repository port (wave-geocredit). Kept
 * deliberately small and separate from the credit-suite ports: the live
 * decision path must never depend on this store. Upsert semantics mirror
 * the unique (application_id, input_fingerprint) index in migration 028 —
 * recomputation with identical inputs is a no-op.
 */

export interface GeoCreditShadowRecord extends GeoCreditShadowScore {
  id: string;
}

export interface GeoCreditShadowCriteria {
  applicationId?: string;
  inputFingerprint?: string;
}

export interface GeoCreditShadowRepository {
  /** Insert or replace the row matching (applicationId, inputFingerprint). */
  upsert(record: GeoCreditShadowRecord): Promise<GeoCreditShadowRecord>;
  find(criteria: GeoCreditShadowCriteria): Promise<GeoCreditShadowRecord[]>;
  findOne(criteria: GeoCreditShadowCriteria): Promise<GeoCreditShadowRecord | undefined>;
  all(): Promise<GeoCreditShadowRecord[]>;
}

export function geoCreditShadowMatcher(
  criteria: GeoCreditShadowCriteria
): (record: GeoCreditShadowRecord) => boolean {
  return (record) =>
    (!criteria.applicationId || record.applicationId === criteria.applicationId) &&
    (!criteria.inputFingerprint || record.inputFingerprint === criteria.inputFingerprint);
}

export class InMemoryGeoCreditShadowRepository implements GeoCreditShadowRepository {
  private readonly items = new Map<string, GeoCreditShadowRecord>();

  upsert(record: GeoCreditShadowRecord): Promise<GeoCreditShadowRecord> {
    const existing = [...this.items.values()].find(
      (item) =>
        item.applicationId === record.applicationId &&
        item.inputFingerprint === record.inputFingerprint
    );
    this.items.set(existing?.id ?? record.id, structuredClone(record));
    return Promise.resolve(record);
  }

  find(criteria: GeoCreditShadowCriteria): Promise<GeoCreditShadowRecord[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(geoCreditShadowMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findOne(criteria: GeoCreditShadowCriteria): Promise<GeoCreditShadowRecord | undefined> {
    return (await this.find(criteria))[0];
  }

  all(): Promise<GeoCreditShadowRecord[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryGeoCreditShadowRepository(): InMemoryGeoCreditShadowRepository {
  return new InMemoryGeoCreditShadowRepository();
}
