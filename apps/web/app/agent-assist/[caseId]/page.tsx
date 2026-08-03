import type { Metadata } from 'next';
import Link from 'next/link';
import { AgentAssistCase } from '@/components/agent-assist-case';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Voice agronomist case',
  description:
    'Escalation case detail: full transcript with RAG citations, suggested answer review and agent response.'
};

export default async function AgentAssistCasePage({
  params
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return (
    <div className="container" style={{ maxWidth: 920 }}>
      <PageHeader
        kicker={<T k="voice.kicker" />}
        title={<T k="voice.caseTitle" />}
        description={
          <Link href="/agent-assist">
            <T k="voice.backToQueue" />
          </Link>
        }
      />
      <AgentAssistCase caseId={caseId} />
    </div>
  );
}
