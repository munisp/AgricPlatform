import { describe, expect, it } from 'vitest';
import { calculateProfileCompletion, formatNaira, opportunityMatchesProfile, profileBadge } from '../src/profile.js';

describe('profile completion', () => {
  it('rewards progressively richer profiles', () => {
    const score = calculateProfileCompletion({
      location: { state: 'Kaduna', lga: 'Zaria' },
      farmingInterests: ['maize'],
      valueChains: ['Maize'],
      bio: 'Smallholder farmer focused on improved maize production.',
      farmSizeHectares: 2,
      yearsExperience: 4
    });
    expect(score).toBe(100);
    expect(profileBadge(score)).toBe('verified');
  });

  it('caps incomplete profiles', () => {
    const score = calculateProfileCompletion({ location: { state: 'Kano', lga: '' }, farmingInterests: [] });
    expect(score).toBe(20);
    expect(profileBadge(score)).toBe('starter');
  });
});

describe('opportunity matching', () => {
  it('matches state and value chain', () => {
    expect(opportunityMatchesProfile({
      opportunityStates: ['Kaduna'],
      opportunityValueChains: ['Cassava'],
      profileState: 'Kaduna',
      profileValueChains: ['Cassava']
    })).toBe(true);
  });

  it('rejects mismatched profiles', () => {
    expect(opportunityMatchesProfile({
      opportunityStates: ['Lagos'],
      opportunityValueChains: ['Poultry'],
      profileState: 'Kano',
      profileValueChains: ['Maize']
    })).toBe(false);
  });
});

describe('formatNaira', () => {
  it('formats Nigerian currency', () => {
    expect(formatNaira(125000)).toContain('125,000');
  });
});
