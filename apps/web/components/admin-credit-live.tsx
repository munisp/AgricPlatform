'use client';

import { useState } from 'react';
import type { CreditLoanApplication } from '@agric-platform/shared';
import { useApiQuery } from '@/lib/api/hooks';
import {
  approveCreditLoan,
  defaultCreditLoan,
  disburseCreditLoan,
  fetchCreditPortfolio,
  listCreditGuarantors,
  listCreditLoans,
  rejectCreditLoan,
  scoreCreditLoan,
  startCreditRepayment
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { QueryState } from '@/components/api-state';
import { Card, EmptyState, StatusBadge, formatKobo } from '@/components/ui';

const REVIEW_STATUSES = new Set(['submitted', 'scoring', 'approved', 'disbursed', 'repaying']);

function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/* ------------------------------- PAR cards ------------------------------- */

export function CreditPortfolioSection() {
  const { t } = useT();
  const query = useApiQuery('credit:portfolio', () =>
    fetchCreditPortfolio().then((res) => res.data)
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data ? (
        <div className="grid grid-4">
          <Card title={t('credit.par30Label')}>
            <div className="metric-value" aria-label={`PAR 30 ${bpsToPercent(query.data.par30Bps)}`}>
              {bpsToPercent(query.data.par30Bps)}
            </div>
            <p className="small muted">{formatKobo(query.data.par30Kobo)}</p>
          </Card>
          <Card title={t('credit.par60Label')}>
            <div className="metric-value" aria-label={`PAR 60 ${bpsToPercent(query.data.par60Bps)}`}>
              {bpsToPercent(query.data.par60Bps)}
            </div>
            <p className="small muted">{formatKobo(query.data.par60Kobo)}</p>
          </Card>
          <Card title={t('credit.par90Label')}>
            <div className="metric-value" aria-label={`PAR 90 ${bpsToPercent(query.data.par90Bps)}`}>
              {bpsToPercent(query.data.par90Bps)}
            </div>
            <p className="small muted">{formatKobo(query.data.par90Kobo)}</p>
          </Card>
          <Card title={t('credit.outstandingLabel')}>
            <div className="metric-value">{formatKobo(query.data.outstandingKobo)}</div>
            <p className="small muted">
              {t('credit.defaultsLabel')}: {query.data.defaultedLoans} (
              {formatKobo(query.data.defaultedKobo)})
            </p>
          </Card>
        </div>
      ) : null}
    </QueryState>
  );
}

/* ------------------------------ review queue ----------------------------- */

function ReviewActions({
  loan,
  onDone
}: {
  loan: CreditLoanApplication;
  onDone: () => void;
}) {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: (id: string) => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action(loan.id);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="cluster" role="group" aria-label={`Actions for ${loan.id}`}>
      {loan.status === 'submitted' ? (
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => void act(scoreCreditLoan)}
        >
          {pending ? t('credit.working') : t('credit.scoreAction')}
        </button>
      ) : null}
      {loan.status === 'scoring' ? (
        <>
          <button
            type="button"
            className="button button-primary"
            disabled={pending}
            onClick={() => void act(approveCreditLoan)}
          >
            {t('credit.approveAction')}
          </button>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => void act(rejectCreditLoan)}
          >
            {t('credit.rejectAction')}
          </button>
        </>
      ) : null}
      {loan.status === 'approved' ? (
        <button
          type="button"
          className="button button-primary"
          disabled={pending}
          onClick={() => void act(disburseCreditLoan)}
        >
          {t('credit.disburseAction')}
        </button>
      ) : null}
      {loan.status === 'disbursed' ? (
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => void act(startCreditRepayment)}
        >
          {t('credit.activateAction')}
        </button>
      ) : null}
      {loan.status === 'repaying' ? (
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => void act(defaultCreditLoan)}
        >
          {t('credit.defaultAction')}
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="small" style={{ color: 'var(--color-danger, #b91c1c)' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function CreditReviewQueueSection() {
  const { t } = useT();
  const query = useApiQuery('credit:loans:review', () =>
    listCreditLoans().then((res) => res.data.filter((loan) => REVIEW_STATUSES.has(loan.status)))
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data && query.data.length === 0 ? <EmptyState title={t('credit.queueEmpty')} /> : null}
      {query.data && query.data.length > 0 ? (
        <div className="stack">
          {query.data.map((loan) => (
            <Card key={loan.id} title={`${formatKobo(loan.principalKobo)} — ${loan.applicantUserId}`}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <StatusBadge tone={loan.status === 'scoring' ? 'warning' : 'neutral'}>
                  {loan.status}
                </StatusBadge>
                {loan.groupId ? <StatusBadge tone="neutral">{t('credit.groupBadge')}</StatusBadge> : null}
              </div>
              {loan.scoreFactors ? (
                <ul className="stack" aria-label={`Score breakdown for ${loan.id}`}>
                  {Object.entries(loan.scoreFactors).map(([factor, value]) => (
                    <li
                      key={factor}
                      className="cluster"
                      style={{ justifyContent: 'space-between' }}
                    >
                      <span className="small">{factor}</span>
                      <span className="small" style={{ fontWeight: 700 }}>
                        {value}
                      </span>
                    </li>
                  ))}
                  <li className="cluster" style={{ justifyContent: 'space-between' }}>
                    <span className="small" style={{ fontWeight: 700 }}>
                      {t('credit.scoreTitle')}
                    </span>
                    <span className="small" style={{ fontWeight: 700 }}>
                      {t('credit.scoreOutOf', { score: loan.creditScore ?? 0 })}
                    </span>
                  </li>
                </ul>
              ) : null}
              <ReviewActions loan={loan} onDone={query.refresh} />
            </Card>
          ))}
        </div>
      ) : null}
    </QueryState>
  );
}

/* ------------------------------ group lending ---------------------------- */

function GroupLoanCard({ loan }: { loan: CreditLoanApplication }) {
  const { t } = useT();
  const guarantors = useApiQuery(`credit:guarantors:${loan.id}`, () =>
    listCreditGuarantors(loan.id).then((res) => res.data)
  );
  return (
    <Card title={`${formatKobo(loan.principalKobo)} — ${loan.applicantUserId}`}>
      <p className="small muted">
        {loan.id} · {t('credit.groupBadge')} {loan.groupId}
      </p>
      <StatusBadge tone="neutral">{loan.status}</StatusBadge>{' '}
      {guarantors.data ? (
        <StatusBadge tone="success">
          {t('credit.coObligorsLabel', { count: guarantors.data.length })}
        </StatusBadge>
      ) : null}
    </Card>
  );
}

export function CreditGroupLoansSection() {
  const { t } = useT();
  const query = useApiQuery('credit:loans:group', () =>
    listCreditLoans().then((res) => res.data.filter((loan) => loan.groupId))
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data && query.data.length === 0 ? (
        <EmptyState title={t('credit.groupLoansEmpty')} />
      ) : null}
      {query.data && query.data.length > 0 ? (
        <div className="grid grid-2">
          {query.data.map((loan) => (
            <GroupLoanCard key={loan.id} loan={loan} />
          ))}
        </div>
      ) : null}
    </QueryState>
  );
}
