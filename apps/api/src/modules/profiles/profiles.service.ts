import { Injectable } from '@nestjs/common';
import {
  calculateProfileCompletion,
  profileBadge,
  type LocationRef,
  type Profile
} from '@agric-platform/shared';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { seedProfiles } from '../../database/seed-data.js';
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
  private readonly repo: InMemoryRepository<Profile & { id: string }>;

  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService
  ) {
    this.repo = new InMemoryRepository(
      seedProfiles.map((profile) => ({ ...profile, id: profile.userId }))
    );
  }

  get(userId: string): Profile {
    const stored = this.repo.getById(userId);
    return this.toProfile(stored);
  }

  upsert(userId: string, input: UpsertProfileInput): Profile {
    this.users.getById(userId); // ensure the user exists
    const existing = this.repo.findById(userId);
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
    const stored = { ...merged, id: userId };
    if (existing) {
      this.repo.update(userId, stored);
    } else {
      this.repo.create(stored);
    }
    if (merged.completionScore !== previousScore) {
      this.events.publish(
        'profile.completion.updated',
        { userId, score: merged.completionScore, previousScore },
        userId
      );
    }
    return merged;
  }

  completion(userId: string): CompletionReport {
    const profile = this.get(userId);
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

  all(): Profile[] {
    return this.repo.all().map((stored) => this.toProfile(stored));
  }

  private toProfile(stored: Profile & { id: string }): Profile {
    const { id: _id, ...profile } = stored;
    return profile;
  }
}
