import { Inject, Injectable } from '@nestjs/common';
import {
  calculateProfileCompletion,
  profileBadge,
  type LocationRef,
  type Profile
} from '@agric-platform/shared';
import { PROFILE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { UsersService } from '../users/users.service.js';

export interface UpsertProfileInput {
  location?: LocationRef;
  farmingInterests?: string[];
  valueChains?: string[];
  bio?: string;
  farmSizeHectares?: number;
  yearsExperience?: number;
}

export interface CompletionReport {
  userId: string;
  score: number;
  badge: ReturnType<typeof profileBadge>;
  missing: string[];
}

@Injectable()
export class ProfilesService {
  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Inject(PROFILE_REPOSITORY) private readonly repo: ProfileRepository
  ) {}

  async get(userId: string): Promise<Profile> {
    return this.repo.getByUserId(userId);
  }

  async upsert(userId: string, input: UpsertProfileInput): Promise<Profile> {
    await this.users.getById(userId); // ensure the user exists
    const existing = await this.repo.findByUserId(userId);
    const previousScore = existing?.completionScore ?? 0;
    const merged: Profile = {
      userId,
      location: input.location ?? existing?.location ?? { state: '', lga: '' },
      farmingInterests: input.farmingInterests ?? existing?.farmingInterests ?? [],
      valueChains: input.valueChains ?? existing?.valueChains ?? [],
      bio: input.bio ?? existing?.bio,
      farmSizeHectares: input.farmSizeHectares ?? existing?.farmSizeHectares,
      yearsExperience: input.yearsExperience ?? existing?.yearsExperience,
      completionScore: 0,
      badges: existing?.badges ?? []
    };
    merged.completionScore = calculateProfileCompletion(merged);
    merged.badges = [profileBadge(merged.completionScore)];
    await this.repo.upsert(merged);
    if (merged.completionScore !== previousScore) {
      await this.events.publish(
        'profile.completion.updated',
        { userId, score: merged.completionScore, previousScore },
        userId
      );
    }
    return merged;
  }

  async completion(userId: string): Promise<CompletionReport> {
    const profile = await this.get(userId);
    const missing: string[] = [];
    if (!profile.location?.state) missing.push('location.state');
    if (!profile.location?.lga) missing.push('location.lga');
    if (profile.farmingInterests.length === 0) missing.push('farmingInterests');
    if (profile.valueChains.length === 0) missing.push('valueChains');
    if (!profile.bio || profile.bio.trim().length < 20) missing.push('bio');
    if (!(profile.farmSizeHectares && profile.farmSizeHectares > 0)) missing.push('farmSizeHectares');
    if (typeof profile.yearsExperience !== 'number') missing.push('yearsExperience');
    return {
      userId,
      score: profile.completionScore,
      badge: profileBadge(profile.completionScore),
      missing
    };
  }

  async all(): Promise<Profile[]> {
    return this.repo.all();
  }

  async countByState(): Promise<Map<string, number>> {
    return this.repo.countByState();
  }
}
