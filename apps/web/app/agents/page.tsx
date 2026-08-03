import type { Metadata } from 'next';
import { AgentsBoard } from '@/components/agents-board';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Field agents',
  description:
    'Enumerator assignment board: create field work, follow completion and review per-agent productivity.'
};

export default function AgentsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="agents.kicker" />}
        title={<T k="agents.title" />}
        description={<T k="agents.description" />}
      />
      <Section kicker={<T k="agents.boardKicker" />} title={<T k="agents.boardTitle" />}>
        <AgentsBoard />
      </Section>
    </div>
  );
}
