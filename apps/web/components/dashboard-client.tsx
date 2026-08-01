'use client';

import Link from 'next/link';
import { useAppState } from '@/lib/app-state';
import { usePersistentState } from '@/lib/use-persistent-state';
import { MODULES, ROLE_LABELS, ROLE_SUMMARIES } from '@/lib/content';
import { calculateProfileCompletion, profileBadge } from '@agric-platform/shared';
import { ModuleCard, ProgressBar, StatusBadge } from '@/components/ui';

interface OnboardingDraft {
  fullName?: string;
  state?: string;
  lga?: string;
  farmingInterests?: string[];
  valueChains?: string[];
  bio?: string;
  farmSizeHectares?: string;
  yearsExperience?: string;
}

export function RoleDashboard() {
  const { role, hydrated } = useAppState();
  const [profile] = usePersistentState<OnboardingDraft>('agric.onboarding-draft', {});

  const score = calculateProfileCompletion({
    location: profile.state ? { state: profile.state, lga: profile.lga ?? '' } : undefined,
    farmingInterests: profile.farmingInterests ?? [],
    valueChains: profile.valueChains ?? [],
    bio: profile.bio ?? '',
    farmSizeHectares: profile.farmSizeHectares ? Number(profile.farmSizeHectares) : undefined,
    yearsExperience: profile.yearsExperience ? Number(profile.yearsExperience) : undefined
  });

  const modules = MODULES.filter((mod) => mod.roles.includes(role));
  const firstName = profile.fullName?.trim().split(' ')[0];

  return (
    <div className="stack-lg">
      <div className="card">
        <div className="cluster" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ marginBottom: '0.2rem' }}>
              {hydrated && firstName ? `Sannu, ${firstName}` : 'Welcome back'} ·{' '}
              {ROLE_LABELS[role]}
            </h3>
            <p className="small muted" style={{ margin: 0 }}>
              {ROLE_SUMMARIES[role]}
            </p>
          </div>
          <StatusBadge tone={score >= 60 ? 'success' : 'warning'}>{profileBadge(score)} profile</StatusBadge>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <ProgressBar value={score} label="Profile completion" />
        </div>
        {score < 100 ? (
          <p className="small" style={{ marginTop: '0.75rem' }}>
            <Link href="/onboarding">Complete your profile</Link> to unlock more matches and lender
            readiness.
          </p>
        ) : null}
      </div>

      <section aria-label="Role modules">
        <h3>Your modules</h3>
        <div className="grid grid-3">
          {modules.map((mod) => (
            <ModuleCard
              key={mod.href}
              href={mod.href}
              title={mod.title}
              description={mod.description}
              tag={mod.tag}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
