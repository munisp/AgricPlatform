import type { Metadata } from 'next';
import {
  AgentCommissionSection,
  AgentFloatSection,
  AgentTopUpQueueSection,
  AgentTopUpSection,
  AgentTransactionLogSection,
  AgentVoucherRedeemSection,
  AgentVoucherSection
} from '@/components/agent-banking-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Agent Banking',
  description:
    'Rural agent float, farmer cash-in/cash-out, signed offline vouchers and commissions.'
};

export default function AgentBankingPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="agentBanking.kicker" />}
        title={<T k="agentBanking.title" />}
        description={<T k="agentBanking.description" />}
      />

      <Section kicker={<T k="agentBanking.floatKicker" />} title={<T k="agentBanking.floatTitle" />}>
        <AgentFloatSection />
      </Section>

      <Section kicker={<T k="agentBanking.topUpKicker" />} title={<T k="agentBanking.topUpTitle" />}>
        <AgentTopUpSection />
      </Section>

      <Section kicker={<T k="agentBanking.queueKicker" />} title={<T k="agentBanking.queueTitle" />}>
        <AgentTopUpQueueSection />
      </Section>

      <Section
        kicker={<T k="agentBanking.transactionsKicker" />}
        title={<T k="agentBanking.transactionsTitle" />}
      >
        <AgentTransactionLogSection />
      </Section>

      <Section
        kicker={<T k="agentBanking.vouchersKicker" />}
        title={<T k="agentBanking.vouchersTitle" />}
      >
        <AgentVoucherSection />
      </Section>

      <Section kicker={<T k="agentBanking.redeemKicker" />} title={<T k="agentBanking.redeemTitle" />}>
        <AgentVoucherRedeemSection />
      </Section>

      <Section
        kicker={<T k="agentBanking.commissionsKicker" />}
        title={<T k="agentBanking.commissionsTitle" />}
      >
        <AgentCommissionSection />
      </Section>
    </div>
  );
}
