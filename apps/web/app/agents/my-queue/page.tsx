import type { Metadata } from 'next';
import { AgentQueue } from '@/components/agent-queue';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'My field queue',
  description:
    'Enumerator queue: open field assignments with progress reporting and on-behalf farmer profile capture.'
};

export default function AgentMyQueuePage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="agents.queueKicker" />}
        title={<T k="agents.queueTitle" />}
        description={<T k="agents.queueDescription" />}
      />
      <Section kicker={<T k="agents.queueKicker" />} title={<T k="agents.queueTitle" />}>
        <AgentQueue />
      </Section>
    </div>
  );
}
