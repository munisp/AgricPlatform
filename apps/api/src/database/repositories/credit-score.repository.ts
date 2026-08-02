import type { CreditScoreResult } from '@agric-platform/shared';

/**
 * Versioned credit score port keyed by user_id (finance.credit_scores).
 * Distinct from the legacy finance.credit_profiles readiness record.
 */
export interface CreditScoreRepository {
  findByUserId(userId: string): Promise<CreditScoreResult | undefined>;
  upsert(result: CreditScoreResult): Promise<CreditScoreResult>;
}

export class InMemoryCreditScoreRepository implements CreditScoreRepository {
  private readonly items = new Map<string, CreditScoreResult>();

  constructor(seed: readonly CreditScoreResult[] = []) {
    for (const result of seed) {
      this.items.set(result.userId, structuredClone(result));
    }
  }

  async findByUserId(userId: string): Promise<CreditScoreResult | undefined> {
    return this.items.get(userId);
  }

  async upsert(result: CreditScoreResult): Promise<CreditScoreResult> {
    this.items.set(result.userId, result);
    return result;
  }
}

export function createInMemoryCreditScoreRepository(): InMemoryCreditScoreRepository {
  return new InMemoryCreditScoreRepository();
}
