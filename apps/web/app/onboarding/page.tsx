import type { Metadata } from 'next';
import { OnboardingWizard } from '@/components/onboarding-wizard';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Join NYFN',
  description: 'Role-based onboarding with progressive profile completion for farmers, students, buyers, suppliers, chapter leads, partners and admins.'
};

export default function OnboardingPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Onboarding"
        title="Create your NYFN account"
        description="Five short steps. Your progress is saved on this device as you go — nothing is lost if your connection drops."
      />
      <section className="section-tight" style={{ maxWidth: 760 }}>
        <OnboardingWizard />
      </section>
    </div>
  );
}
