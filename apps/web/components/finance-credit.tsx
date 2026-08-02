'use client';

import { useState } from 'react';
import type { Lender, LoanApplication, RepaymentInstallment } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  applyForLoan,
  fetchCreditScore,
  fetchLenderMatches,
  fetchLoanSchedule,
  payLoanInstallment,
  listLoans
} from '@/lib/api/endpoints';
import type { LenderRanking } from '@/lib/api/endpoints';
import { Field, Select, TextArea, TextInput } from '@/components/forms';
import { ApiErrorNotice, QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, ProgressBar, StatusBadge, formatKobo } from '@/components/ui';

const FACTOR_LABELS: Record<string, string> = {
  base: 'Base',
  training: 'Training',
  trade_history: 'Trade history',
  repayment_history: 'Repayment history',
  documentation: 'Documentation',
  penalties: 'Penalties'
};

/* ----------------------------- credit score ----------------------------- */

export function CreditScoreSection() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `credit-score:${userId}` : null,
    () => fetchCreditScore(userId).then((res) => res.data),
    { enabled: hydrated }
  );

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data ? (
        <div className="grid grid-2">
          <Card title="Your platform credit score">
            <div className="metric-value" aria-label={`Credit score ${query.data.score} out of 100`}>
              {query.data.score}
              <span className="small muted"> / 100</span>
            </div>
            <p className="small muted">
              Version {query.data.version} · computed{' '}
              {new Date(query.data.computedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
            </p>
          </Card>
          <Card title="Factor breakdown">
            <div className="stack">
              {Object.entries(query.data.components).map(([factor, value]) => (
                <div key={factor}>
                  <div className="cluster" style={{ justifyContent: 'space-between' }}>
                    <span className="small">{FACTOR_LABELS[factor] ?? factor}</span>
                    <span className="small" style={{ fontWeight: 700 }}>
                      {factor === 'penalties' ? `−${value}` : `+${value}`}
                    </span>
                  </div>
                  <ProgressBar
                    value={Math.min(100, value * (factor === 'base' ? 10 : 2.5))}
                    label={undefined}
                  />
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}
    </QueryState>
  );
}

/* ------------------------------ loan apply ------------------------------ */

export function LoanApplicationForm({ matches }: { matches: LenderRanking[] }) {
  const { userId } = useAppState();
  const eligible = matches.filter((match) => match.eligible);
  const lenders = (eligible.length > 0 ? eligible : matches).map((match) => match.lender);

  const [lenderId, setLenderId] = useState('');
  const [amountNaira, setAmountNaira] = useState('');
  const [termMonths, setTermMonths] = useState('12');
  const [ratePercent, setRatePercent] = useState('10');
  const [purpose, setPurpose] = useState('');
  const [submitted, setSubmitted] = useState<LoanApplication | null>(null);

  const selectedLender: Lender | undefined = lenders.find((lender) => lender.id === lenderId);

  const mutation = useApiMutation<
    {
      applicantId: string;
      lenderId: string;
      amountKobo: number;
      termMonths: number;
      annualRateBps: number;
      purpose?: string;
    },
    LoanApplication
  >({
    mutationFn: (input) => applyForLoan(input).then((res) => res.data),
    queue: {
      kind: 'finance.loan.applied',
      label: (input) => `Loan application: ₦${(input.amountKobo / 100).toLocaleString('en-NG')}`,
      method: 'POST',
      path: () => '/finance/loans',
      payload: (input) => input
    },
    onSuccess: (loan) => setSubmitted(loan),
    onQueued: () =>
      setSubmitted({
        id: 'queued',
        applicantId: userId,
        lenderId,
        amountKobo: Math.round(Number(amountNaira) * 100),
        termMonths: Number(termMonths),
        annualRateBps: Math.round(Number(ratePercent) * 100),
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
  });

  const valid =
    lenderId !== '' && Number(amountNaira) >= 1000 && Number(termMonths) >= 1;

  if (submitted) {
    return (
      <div className="notice notice-success" role="status">
        <strong>Application saved.</strong> Your loan application is{' '}
        {submitted.id === 'queued' ? 'queued on this device and will sync when you reconnect' : `recorded as ${submitted.status.replace(/_/g, ' ')}`}.
        <div className="cluster" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              setSubmitted(null);
              setAmountNaira('');
              setPurpose('');
            }}
          >
            Start another application
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Apply for a loan</h3>
      {lenders.length === 0 ? (
        <p className="small muted">
          No lenders are available yet — check back once the lender directory is populated.
        </p>
      ) : (
        <>
          <div className="form-grid cols-2">
            <Field id="ln-lender" label="Lender">
              <Select id="ln-lender" value={lenderId} onChange={(e) => setLenderId(e.target.value)}>
                <option value="">Choose a lender…</option>
                {lenders.map((lender) => (
                  <option key={lender.id} value={lender.id}>
                    {lender.name} — {lender.product}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="ln-amount"
              label="Amount (₦)"
              hint={
                selectedLender
                  ? `Ticket range ${formatKobo(selectedLender.minTicketKobo)} – ${formatKobo(selectedLender.maxTicketKobo)}`
                  : undefined
              }
            >
              <TextInput
                id="ln-amount"
                value={amountNaira}
                inputMode="numeric"
                onChange={(e) => setAmountNaira(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="250000"
              />
            </Field>
            <Field id="ln-term" label="Term (months)">
              <TextInput
                id="ln-term"
                value={termMonths}
                inputMode="numeric"
                onChange={(e) => setTermMonths(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
            <Field id="ln-rate" label="Annual rate (%)" hint="Integer or decimal, e.g. 27.5">
              <TextInput
                id="ln-rate"
                value={ratePercent}
                inputMode="decimal"
                onChange={(e) => setRatePercent(e.target.value.replace(/[^0-9.]/g, ''))}
              />
            </Field>
            <Field id="ln-purpose" label="Purpose (optional)">
              <TextArea
                id="ln-purpose"
                value={purpose}
                rows={2}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. Fertiliser and seed for the wet season"
              />
            </Field>
          </div>
          <div className="cluster" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!valid || mutation.status === 'pending'}
              onClick={() =>
                void mutation.mutate({
                  applicantId: userId,
                  lenderId,
                  amountKobo: Math.round(Number(amountNaira) * 100),
                  termMonths: Number(termMonths),
                  annualRateBps: Math.round(Number(ratePercent) * 100),
                  purpose: purpose.trim() || undefined
                })
              }
            >
              {mutation.status === 'pending' ? 'Saving…' : 'Save application'}
            </button>
          </div>
          {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}
        </>
      )}
    </div>
  );
}

/* ---------------------------- lender matches ---------------------------- */

export function LenderMatchSection() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `lender-matches:${userId}` : null,
    () => fetchLenderMatches(userId).then((res) => res.data),
    { fallbackData: [], enabled: hydrated }
  );
  const matches = query.data ?? [];

  return (
    <>
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={matches.length > 0 ? matches : undefined}
        onRetry={query.refresh}
        empty={<EmptyState title="No lender matches yet" hint="Build your credit profile to unlock matches." />}
      >
        <ul className="row-list">
          {matches.map((match) => (
            <li className="row-item" key={match.lender.id}>
              <div className="row-main">
                <div className="row-title">
                  {match.lender.name} — {match.lender.product}
                </div>
                <div className="small muted">
                  {formatKobo(match.lender.minTicketKobo)} – {formatKobo(match.lender.maxTicketKobo)} ·{' '}
                  {match.reason}
                </div>
              </div>
              <StatusBadge tone={match.eligible ? 'success' : 'neutral'}>
                {match.eligible ? 'eligible' : 'not yet'}
              </StatusBadge>
            </li>
          ))}
        </ul>
      </QueryState>
      <LoanApplicationForm matches={matches} />
    </>
  );
}

/* ------------------------- repayment schedule --------------------------- */

function ScheduleTable({ loan }: { loan: LoanApplication }) {
  const query = useApiQuery(
    `loan-schedule:${loan.id}`,
    () => fetchLoanSchedule(loan.id).then((res) => res.data),
    { fallbackData: [] }
  );

  const payMutation = useApiMutation<{ sequence: number }, RepaymentInstallment>({
    mutationFn: ({ sequence }) => payLoanInstallment(loan.id, sequence).then((res) => res.data),
    queue: {
      kind: 'finance.installment.paid',
      label: ({ sequence }) => `Installment ${sequence} for loan ${loan.id}`,
      method: 'POST',
      path: ({ sequence }) => `/finance/loans/${loan.id}/installments/${sequence}/pay`
    },
    onSuccess: () => query.refresh(),
    onQueued: () => query.refresh()
  });

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={
        <p className="small muted">
          No repayment calendar yet — it is generated when the loan is disbursed.
        </p>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Due date</th>
              <th>Principal</th>
              <th>Interest</th>
              <th>Total</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((installment) => (
              <tr key={installment.id}>
                <td>{installment.sequence}</td>
                <td>{new Date(installment.dueDate).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                <td>{formatKobo(installment.principalKobo)}</td>
                <td>{formatKobo(installment.interestKobo)}</td>
                <td>{formatKobo(installment.totalKobo)}</td>
                <td>
                  <AutoBadge value={installment.status} />
                </td>
                <td>
                  {installment.status !== 'paid' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={payMutation.status === 'pending'}
                      onClick={() => void payMutation.mutate({ sequence: installment.sequence })}
                      aria-label={`Mark installment ${installment.sequence} as paid`}
                    >
                      Mark paid
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {payMutation.status === 'error' ? <ApiErrorNotice error={payMutation.error} /> : null}
    </QueryState>
  );
}

export function MyLoansSection() {
  const { userId, hydrated } = useAppState();
  const [openLoanId, setOpenLoanId] = useState<string | null>(null);

  const query = useApiQuery(
    hydrated ? `loans:${userId}` : null,
    () => listLoans({ applicantId: userId }).then((res) => res.data),
    { fallbackData: [], enabled: hydrated }
  );

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title="No loan applications yet" hint="Apply from the lender matches above." />}
    >
      <div className="stack">
        {(query.data ?? []).map((loan) => (
          <Card key={loan.id}>
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>
                {formatKobo(loan.amountKobo)} over {loan.termMonths} months
              </h3>
              <AutoBadge value={loan.status} />
            </div>
            <p className="small muted">
              {(loan.annualRateBps / 100).toFixed(1)}% per year
              {loan.purpose ? ` · ${loan.purpose}` : ''} · created{' '}
              {new Date(loan.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
            </p>
            {['disbursed', 'repaying', 'closed', 'defaulted'].includes(loan.status) ? (
              <div className="cluster" style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => setOpenLoanId(openLoanId === loan.id ? null : loan.id)}
                  aria-expanded={openLoanId === loan.id}
                >
                  {openLoanId === loan.id ? 'Hide schedule' : 'Repayment schedule'}
                </button>
              </div>
            ) : null}
            {openLoanId === loan.id ? <ScheduleTable loan={loan} /> : null}
          </Card>
        ))}
      </div>
    </QueryState>
  );
}
