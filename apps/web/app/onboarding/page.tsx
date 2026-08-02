import type { Metadata } from 'next';
import { OnboardingWizard } from '@/components/onboarding-wizard';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Join NYFN',
  description: 'Role-based onboarding with progressive profile completion for farmers, students, buyers, suppliers, chapter leads, partners and admins.'
};

export default function OnboardingPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="onboarding.kicker" />}
        title={<T k="onboarding.title" />}
        description={<T k="onboarding.description" />}
      />
      <section className="section-tight" style={{ maxWidth: 760 }}>
        <OnboardingWizard />
      </section>
    </div>
  );
}
