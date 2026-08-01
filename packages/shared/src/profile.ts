import type { Profile } from './domain.js';

export function calculateProfileCompletion(profile: Partial<Profile>): number {
  let score = 0;
  if (profile.location?.state) score += 20;
  if (profile.location?.lga) score += 15;
  if ((profile.farmingInterests?.length ?? 0) > 0) score += 20;
  if ((profile.valueChains?.length ?? 0) > 0) score += 15;
  if (profile.bio && profile.bio.trim().length >= 20) score += 10;
  if (typeof profile.farmSizeHectares === 'number' && profile.farmSizeHectares > 0) score += 10;
  if (typeof profile.yearsExperience === 'number') score += 10;
  return Math.min(100, score);
}

export function profileBadge(score: number): 'starter' | 'complete' | 'verified' {
  if (score >= 80) return 'verified';
  if (score >= 60) return 'complete';
  return 'starter';
}

export function opportunityMatchesProfile(input: {
  opportunityStates: string[];
  opportunityValueChains: string[];
  profileState?: string;
  profileValueChains?: string[];
}): boolean {
  const stateMatches =
    input.opportunityStates.length === 0 ||
    (input.profileState ? input.opportunityStates.includes(input.profileState) : false);
  const chainMatches =
    input.opportunityValueChains.length === 0 ||
    (input.profileValueChains ?? []).some((chain) => input.opportunityValueChains.includes(chain));
  return stateMatches && chainMatches;
}

export function formatNaira(value: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0
  }).format(value);
}
