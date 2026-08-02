import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FEATURE_FLAG_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  FeatureFlag,
  FeatureFlagRepository
} from '../../database/repositories/feature-flag.repository.js';

export interface FeatureFlagContext {
  userId?: string;
  roles?: string[];
}

/** Read-through cache TTL (env-overridable; keeps flag flips near-live). */
export const FEATURE_FLAG_CACHE_TTL_MS = 30_000;

/**
 * DB-backed feature flags (Wave P). Evaluation is fail-closed: unknown or
 * disabled flags evaluate to false, and percentage rollouts need a stable
 * subject (userId) — anonymous callers only pass fully-rolled-out flags.
 * Reads are cached briefly so hot paths (SSE stream, guards) do not hit the
 * repository per request; admin writes invalidate the cache immediately.
 */
@Injectable()
export class FeatureFlagsService {
  private cache?: { flags: Map<string, FeatureFlag>; loadedAt: number };

  constructor(
    @Inject(FEATURE_FLAG_REPOSITORY) private readonly flags: FeatureFlagRepository
  ) {}

  async list(): Promise<FeatureFlag[]> {
    return [...(await this.cachedFlags()).values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async get(key: string): Promise<FeatureFlag | undefined> {
    return (await this.cachedFlags()).get(key);
  }

  async isEnabled(key: string, context: FeatureFlagContext = {}): Promise<boolean> {
    const flag = await this.get(key);
    if (!flag || !flag.enabled) {
      return false;
    }
    if (flag.roleAllowlist.length > 0) {
      const roles = context.roles ?? [];
      if (!roles.some((role) => flag.roleAllowlist.includes(role))) {
        return false;
      }
    }
    if (flag.percentage >= 100) {
      return true;
    }
    if (flag.percentage <= 0 || !context.userId) {
      return false;
    }
    return this.bucket(context.userId, key) < flag.percentage;
  }

  async upsert(flag: Omit<FeatureFlag, 'updatedAt'>): Promise<FeatureFlag> {
    const stored = await this.flags.upsert(flag);
    this.invalidate();
    return stored;
  }

  async remove(key: string): Promise<boolean> {
    const removed = await this.flags.remove(key);
    this.invalidate();
    return removed;
  }

  /** Test hook / admin writes: drop the read-through cache. */
  invalidate(): void {
    this.cache = undefined;
  }

  /** Deterministic 0-99 bucket for percentage rollouts (stable per user+flag). */
  private bucket(userId: string, key: string): number {
    const digest = createHash('sha256').update(`${key}:${userId}`).digest();
    return digest.readUInt32BE(0) % 100;
  }

  private async cachedFlags(): Promise<Map<string, FeatureFlag>> {
    const ttl = Number(process.env.FEATURE_FLAG_CACHE_TTL_MS ?? FEATURE_FLAG_CACHE_TTL_MS);
    if (this.cache && Date.now() - this.cache.loadedAt < ttl) {
      return this.cache.flags;
    }
    const flags = new Map((await this.flags.list()).map((flag) => [flag.key, flag]));
    this.cache = { flags, loadedAt: Date.now() };
    return flags;
  }
}
