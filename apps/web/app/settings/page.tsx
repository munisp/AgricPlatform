import type { Metadata } from 'next';
import { DataUsageSection, OfflinePackSection } from '@/components/settings-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'PWA settings: data-usage transparency, reduced-data mode and the offline content pack.'
};

export default function SettingsPage() {
  return (
    <div className="container" style={{ maxWidth: 820 }}>
      <PageHeader
        kicker="PWA settings"
        title="Data and offline"
        description="Built for low connectivity: see what this device downloads, cut non-essential media, and keep reading offline."
      />

      <Section kicker="Transparency" title="Data usage">
        <DataUsageSection />
      </Section>

      <Section kicker="Offline first" title="Offline content pack">
        <OfflinePackSection />
      </Section>
    </div>
  );
}
