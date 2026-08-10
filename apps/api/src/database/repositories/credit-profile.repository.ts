import type { CreditProfile } from '@agric-platform/shared';
import { seedCreditProfiles } from '../seed-data.js';

/**
 * Credit profile port keyed by user_id (finance.credit_profiles).
 * CreditProfile has no surrogate id in the API contract.
 */
export interface CreditProfileRepository {
  findByUserId(userId: string): Promise<CreditProfile | undefined>;
  upsert(profile: CreditProfile): Promise<CreditProfile>;
  /** Total stored profiles — backs the live credit_profiles platform KPI. */
  count(): Promise<number>;
}

export class InMemoryCreditProfileRepository implements CreditProfileRepository {
  private readonly items = new Map<string, CreditProfile>();

  constructor(seed: readonly CreditProfile[] = []) {
    for (const profile of seed) {
      this.items.set(profile.userId, structuredClone(profile));
    }
  }

  async findByUserId(userId: string): Promise<CreditProfile | undefined> {
    return this.items.get(userId);
  }

  async upsert(profile: CreditProfile): Promise<CreditProfile> {
    this.items.set(profile.userId, profile);
    return profile;
  }

  count(): Promise<number> {
    return Promise.resolve(this.items.size);
  }
}

export function createInMemoryCreditProfileRepository(): InMemoryCreditProfileRepository {
  return new InMemoryCreditProfileRepository(seedCreditProfiles);
}
