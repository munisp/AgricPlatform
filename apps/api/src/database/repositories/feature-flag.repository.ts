/**
 * DB-backed feature flags (platform.feature_flags). Reads are cached by
 * FeatureFlagsService; writes go through admin CRUD endpoints.
 */
export interface FeatureFlag {
  key: string;
  enabled: boolean;
  /** Empty = every role; otherwise only listed roles pass. */
  roleAllowlist: string[];
  /** 0-100 deterministic rollout percentage (hashed per user+key). */
  percentage: number;
  description: string;
  updatedAt: string;
}

export interface FeatureFlagRepository {
  get(key: string): Promise<FeatureFlag | undefined>;
  list(): Promise<FeatureFlag[]>;
  upsert(flag: Omit<FeatureFlag, 'updatedAt'>): Promise<FeatureFlag>;
  remove(key: string): Promise<boolean>;
}

export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  private readonly flags = new Map<string, FeatureFlag>();

  async get(key: string): Promise<FeatureFlag | undefined> {
    const flag = this.flags.get(key);
    return flag ? { ...flag, roleAllowlist: [...flag.roleAllowlist] } : undefined;
  }

  async list(): Promise<FeatureFlag[]> {
    return [...this.flags.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((flag) => ({ ...flag, roleAllowlist: [...flag.roleAllowlist] }));
  }

  async upsert(flag: Omit<FeatureFlag, 'updatedAt'>): Promise<FeatureFlag> {
    const stored: FeatureFlag = {
      ...flag,
      roleAllowlist: [...flag.roleAllowlist],
      updatedAt: new Date().toISOString()
    };
    this.flags.set(flag.key, stored);
    return { ...stored, roleAllowlist: [...stored.roleAllowlist] };
  }

  async remove(key: string): Promise<boolean> {
    return this.flags.delete(key);
  }
}

export function createInMemoryFeatureFlagRepository(
  seed: readonly Omit<FeatureFlag, 'updatedAt'>[] = []
): InMemoryFeatureFlagRepository {
  const repo = new InMemoryFeatureFlagRepository();
  for (const flag of seed) {
    void repo.upsert(flag);
  }
  return repo;
}
