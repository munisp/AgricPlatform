import type { Metadata } from 'next';
import { AgentAssistQueue } from '@/components/agent-assist-queue';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Agent assist — voice agronomist',
  description:
    'Escalation queue for the IVR/USSD voice agronomist: grounded AI answers stay with the machine, hard cases reach a human agronomist here.'
};

export default function AgentAssistPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="voice.kicker" />}
        title={<T k="voice.queueTitle" />}
        description={<T k="voice.queueDescription" />}
      />
      <Section kicker={<T k="voice.kicker" />} title={<T k="voice.queueTitle" />}>
        <AgentAssistQueue />
      </Section>
    </div>
  );
}
