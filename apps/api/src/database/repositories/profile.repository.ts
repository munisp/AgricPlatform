import { NotFoundException } from '@nestjs/common';
import type { Profile } from '@agric-platform/shared';
import { seedProfiles } from '../seed-data.js';

export interface ProfileCriteria {
  userId?: string;
  state?: string;
}

/**
 * Profile port keyed by user_id (profiles.member_profiles). Profiles have no
 * surrogate id in the API contract, so this port does not extend the generic
 * AsyncRepository.
 */
export interface ProfileRepository {
  all(): Promise<Profile[]>;
  find(criteria: ProfileCriteria): Promise<Profile[]>;
  findByUserId(userId: string): Promise<Profile | undefined>;
  getByUserId(userId: string): Promise<Profile>;
  upsert(profile: Profile): Promise<Profile>;
  /** GROUP BY location.state for analytics segments. */
  countByState(): Promise<Map<string, number>>;
}

export function profileMatcher(criteria: ProfileCriteria): (profile: Profile) => boolean {
  return (profile) =>
    (!criteria.userId || profile.userId === criteria.userId) &&
    (!criteria.state || profile.location?.state === criteria.state);
}

export class InMemoryProfileRepository implements ProfileRepository {
  private readonly items = new Map<string, Profile>();

  constructor(seed: readonly Profile[] = []) {
    for (const profile of seed) {
      this.items.set(profile.userId, structuredClone(profile));
    }
  }

  async all(): Promise<Profile[]> {
    return [...this.items.values()];
  }

  async find(criteria: ProfileCriteria): Promise<Profile[]> {
    return (await this.all()).filter(profileMatcher(criteria));
  }

  async findByUserId(userId: string): Promise<Profile | undefined> {
    return this.items.get(userId);
  }

  async getByUserId(userId: string): Promise<Profile> {
    const profile = await this.findByUserId(userId);
    if (!profile) {
      throw new NotFoundException(`Profile for user '${userId}' not found`);
    }
    return profile;
  }

  async upsert(profile: Profile): Promise<Profile> {
    this.items.set(profile.userId, profile);
    return profile;
  }

  async countByState(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const profile of this.items.values()) {
      const state = profile.location?.state || 'unknown';
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return counts;
  }
}

export function createInMemoryProfileRepository(): InMemoryProfileRepository {
  return new InMemoryProfileRepository(seedProfiles);
}
