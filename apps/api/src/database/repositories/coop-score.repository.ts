import type { CoopScore } from '@agric-platform/shared';

/**
 * Cooperative-score repository port (stage-27 Innovation 14). Rows map to
 * credit.coop_scores (migration 072). The store is APPEND-ONLY and VERSIONED:
 * there are deliberately no update/delete methods — score history is
 * underwriting evidence. Recompute idempotency is the (cooperativeId,
 * inputsHash) unique pair: appending with an unchanged hash is a no-op
 * (undefined return), mirroring the geo shadow-score doctrine.
 */

export interface CoopScoreRecord extends CoopScore {
  id: string;
}

export interface CoopScoreRepository {
  /**
   * Appends a new version (next per-cooperative version number). Returns
   * undefined WITHOUT writing when a row already exists for
   * (cooperativeId, inputsHash) — idempotent recompute of identical inputs.
   */
  append(record: Omit<CoopScoreRecord, 'version'>): Promise<CoopScoreRecord | undefined>;
  /** Latest version for a cooperative, else undefined. */
  latestFor(cooperativeId: string): Promise<CoopScoreRecord | undefined>;
  /** Full history, newest version first. */
  historyFor(cooperativeId: string): Promise<CoopScoreRecord[]>;
  findByInputsHash(
    cooperativeId: string,
    inputsHash: string
  ): Promise<CoopScoreRecord | undefined>;
}

export class InMemoryCoopScoreRepository implements CoopScoreRepository {
  private readonly items = new Map<string, CoopScoreRecord>();

  append(record: Omit<CoopScoreRecord, 'version'>): Promise<CoopScoreRecord | undefined> {
    const existing = [...this.items.values()].filter(
      (item) => item.cooperativeId === record.cooperativeId
    );
    if (existing.some((item) => item.inputsHash === record.inputsHash)) {
      return Promise.resolve(undefined);
    }
    const version = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1;
    const stored: CoopScoreRecord = { ...structuredClone(record), version };
    this.items.set(stored.id, stored);
    return Promise.resolve(structuredClone(stored));
  }

  latestFor(cooperativeId: string): Promise<CoopScoreRecord | undefined> {
    return Promise.resolve(structuredClone(this.history(cooperativeId)[0]));
  }

  historyFor(cooperativeId: string): Promise<CoopScoreRecord[]> {
    return Promise.resolve(this.history(cooperativeId).map((item) => structuredClone(item)));
  }

  findByInputsHash(
    cooperativeId: string,
    inputsHash: string
  ): Promise<CoopScoreRecord | undefined> {
    const found = [...this.items.values()].find(
      (item) => item.cooperativeId === cooperativeId && item.inputsHash === inputsHash
    );
    return Promise.resolve(found ? structuredClone(found) : undefined);
  }

  private history(cooperativeId: string): CoopScoreRecord[] {
    return [...this.items.values()]
      .filter((item) => item.cooperativeId === cooperativeId)
      .sort((left, right) => right.version - left.version);
  }
}

export function createInMemoryCoopScoreRepository(): InMemoryCoopScoreRepository {
  return new InMemoryCoopScoreRepository();
}
