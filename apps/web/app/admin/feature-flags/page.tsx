import type { Metadata } from 'next';
import { FeatureFlagPanel } from '@/components/platform-admin-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Feature flags',
  description:
    'DB-backed feature flags: enable surfaces, restrict by role, and roll out by percentage.'
};

export default function AdminFeatureFlagsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Feature flags"
        description="Turn platform features on or off, limit them to roles, or roll them out gradually. Unknown flags stay off."
      />
      <Section
        kicker="Rollout"
        title="Flags"
        description="The notifications.sse flag gates the live notification stream."
      >
        <FeatureFlagPanel />
      </Section>
    </div>
  );
}
