'use client';

import { useState } from 'react';
import type {
  CreditLoanApplication,
  CreditLoanProduct,
  CreditRepayment
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import {
  applyForCreditLoan,
  createCreditGroup,
  depositOwnSavings,
  fetchCreditScoreAssessment,
  fetchCreditSchedule,
  fetchOwnSavingsAccount,
  fetchOwnSavingsTransactions,
  joinCreditGroup,
  listCreditLoans,
  listCreditProducts,
  listMyCreditGroups,
  payCreditInstallment,
  submitCreditLoan,
  withdrawOwnSavings
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { Field, TextArea, TextInput } from '@/components/forms';
import { QueryState } from '@/components/api-state';
import { Card, EmptyState, StatusBadge, formatKobo } from '@/components/ui';

function nairaToKobo(naira: string): number | null {
  const value = Number(naira);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

const LOAN_TONES: Record<string, 'success' | 'warning' | 'critical' | 'neutral'> = {
  draft: 'neutral',
  submitted: 'neutral',
  scoring: 'warning',
  approved: 'success',
  rejected: 'critical',
  disbursed: 'success',
  repaying: 'warning',
  repaid: 'success',
  defaulted: 'critical',
  written_off: 'neutral'
};

const REPAYMENT_TONES: Record<string, 'success' | 'warning' | 'critical' | 'neutral'> = {
  pending: 'neutral',
  paid: 'success',
  late: 'warning',
  missed: 'critical'
};

/* -------------------------------- products ------------------------------- */

export function CreditProductsSection() {
  const { t } = useT();
  const query = useApiQuery('credit:products', () =>
    listCreditProducts().then((res) => res.data)
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data && query.data.length === 0 ? (
        <EmptyState title={t('credit.productsEmpty')} />
      ) : null}
      {query.data && query.data.length > 0 ? (
        <div className="grid grid-2">
          {query.data.map((product) => (
            <Card key={product.id} title={product.name}>
              <p className="small muted">
                {formatKobo(product.minPrincipalKobo)} – {formatKobo(product.maxPrincipalKobo)} ·{' '}
                {(product.interestBpsAnnual / 100).toFixed(0)}% · {product.termDays}d
              </p>
              {product.groupLending ? (
                <StatusBadge tone="neutral">{t('credit.groupBadge')}</StatusBadge>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}
    </QueryState>
  );
}

/* ----------------------------- apply wizard ------------------------------ */

export function CreditApplySection() {
  const { userId } = useAppState();
  const { t } = useT();
  const products = useApiQuery('credit:products', () =>
    listCreditProducts().then((res) => res.data)
  );
  const [productId, setProductId] = useState('');
  const [amountNaira, setAmountNaira] = useState('');
  const [purpose, setPurpose] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const eligible = (products.data ?? []).filter((product) => !product.groupLending);
  const selected = eligible.find((product) => product.id === productId);

  async function submit() {
    const principalKobo = nairaToKobo(amountNaira);
    if (!selected || principalKobo === null) {
      setError('Choose a product and enter a valid amount.');
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const draft = await applyForCreditLoan({
        productId: selected.id,
        principalKobo,
        purpose: purpose || undefined
      });
      const submitted = await submitCreditLoan(draft.data.id);
      setNotice(t('credit.appliedNotice', { id: submitted.data.id }));
      setAmountNaira('');
      setPurpose('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Application failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <QueryState
      isLoading={products.isLoading}
      error={products.error}
      data={products.data}
      onRetry={products.refresh}
    >
      <form
        className="stack"
        aria-label={t('credit.applyTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field id="credit-product" label={t('credit.productsTitle')}>
          <select
            id="credit-product"
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
          >
            <option value="">—</option>
            {eligible.map((product: CreditLoanProduct) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="credit-amount" label={t('credit.amountLabel')}>
          <TextInput
            id="credit-amount"
            inputMode="numeric"
            value={amountNaira}
            onChange={(event) => setAmountNaira(event.target.value)}
          />
        </Field>
        {selected ? (
          <p className="small muted">
            {formatKobo(selected.minPrincipalKobo)} – {formatKobo(selected.maxPrincipalKobo)}
          </p>
        ) : null}
        <Field id="credit-purpose" label={t('credit.purposeLabel')}>
          <TextArea
            id="credit-purpose"
            placeholder={t('credit.purposePlaceholder')}
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="notice notice-success">
            {notice}
          </p>
        ) : null}
        <button type="submit" className="button button-primary" disabled={pending || !userId}>
          {pending ? t('credit.submitting') : t('credit.submitApplication')}
        </button>
      </form>
    </QueryState>
  );
}

/* -------------------------------- my loans ------------------------------- */

function LoanSchedule({ loan }: { loan: CreditLoanApplication }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState<number | null>(null);
  const query = useApiQuery(
    open ? `credit:schedule:${loan.id}` : null,
    () => fetchCreditSchedule(loan.id).then((res) => res.data),
    { enabled: open }
  );

  async function pay(sequence: number) {
    setPaying(sequence);
    try {
      await payCreditInstallment(loan.id, sequence);
      query.refresh();
    } finally {
      setPaying(null);
    }
  }

  const payable = loan.status === 'repaying';
  return (
    <div className="stack">
      <button type="button" className="button" onClick={() => setOpen((value) => !value)}>
        {t('credit.scheduleTitle')}
      </button>
      {open ? (
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          data={query.data}
          onRetry={query.refresh}
        >
          {query.data ? (
            <ul className="stack" aria-label={t('credit.scheduleTitle')}>
              {query.data.map((installment: CreditRepayment) => (
                <li key={installment.id} className="cluster" style={{ justifyContent: 'space-between' }}>
                  <span className="small">
                    #{installment.sequence} · {new Date(installment.dueAt).toLocaleDateString('en-NG')}{' '}
                    · {formatKobo(installment.amountKobo)}
                  </span>
                  <span className="cluster">
                    <StatusBadge tone={REPAYMENT_TONES[installment.status] ?? 'neutral'}>
                      {installment.status === 'paid'
                        ? t('credit.paidLabel')
                        : installment.status === 'late'
                          ? t('credit.lateLabel')
                          : installment.status === 'missed'
                            ? t('credit.missedLabel')
                            : t('credit.pendingLabel')}
                    </StatusBadge>
                    {payable && installment.status !== 'paid' ? (
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={paying !== null}
                        onClick={() => void pay(installment.sequence)}
                        aria-label={t('credit.payInstallment', { sequence: installment.sequence })}
                      >
                        {paying === installment.sequence
                          ? t('credit.paying')
                          : t('credit.payInstallment', { sequence: installment.sequence })}
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </QueryState>
      ) : null}
    </div>
  );
}

export function MyCreditLoansSection() {
  const { hydrated } = useAppState();
  const { t } = useT();
  const query = useApiQuery(
    hydrated ? 'credit:loans:mine' : null,
    () => listCreditLoans().then((res) => res.data),
    { enabled: hydrated }
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data && query.data.length === 0 ? (
        <EmptyState title={t('credit.loansEmpty')} />
      ) : null}
      {query.data && query.data.length > 0 ? (
        <div className="stack">
          {query.data.map((loan) => (
            <Card key={loan.id} title={`${formatKobo(loan.principalKobo)} — ${loan.id}`}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <StatusBadge tone={LOAN_TONES[loan.status] ?? 'neutral'}>{loan.status}</StatusBadge>
                {loan.creditScore !== undefined ? (
                  <span className="small muted">
                    {t('credit.scoreOutOf', { score: loan.creditScore })}
                  </span>
                ) : null}
              </div>
              {['disbursed', 'repaying', 'repaid', 'defaulted'].includes(loan.status) ? (
                <LoanSchedule loan={loan} />
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}
    </QueryState>
  );
}

/* --------------------------------- groups -------------------------------- */

export function CreditGroupsSection() {
  const { hydrated } = useAppState();
  const { t } = useT();
  const query = useApiQuery(
    hydrated ? 'credit:groups:mine' : null,
    () => listMyCreditGroups().then((res) => res.data),
    { enabled: hydrated }
  );
  const [name, setName] = useState('');
  const [joinId, setJoinId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      setName('');
      setJoinId('');
      query.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Group action failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      <div className="stack">
        {query.data && query.data.length === 0 ? (
          <EmptyState title={t('credit.groupsEmpty')} />
        ) : null}
        {query.data?.map(({ group, members }) => (
          <Card key={group.id} title={group.name}>
            <p className="small muted">
              {group.id} · {t('credit.membersCount', { count: members.length })}
            </p>
            <div className="cluster">
              {members.map((member) => (
                <StatusBadge key={member.userId} tone={member.role === 'leader' ? 'success' : 'neutral'}>
                  {member.userId}
                  {member.role === 'leader' ? ` · ${t('credit.leaderBadge')}` : ''}
                </StatusBadge>
              ))}
            </div>
          </Card>
        ))}
        <form
          className="cluster"
          aria-label={t('credit.createGroup')}
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => createCreditGroup({ name }));
          }}
        >
          <Field id="credit-group-name" label={t('credit.groupNameLabel')}>
            <TextInput
              id="credit-group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <button type="submit" className="button" disabled={pending || !name.trim()}>
            {pending ? t('credit.creating') : t('credit.createGroup')}
          </button>
        </form>
        <form
          className="cluster"
          aria-label={t('credit.joinGroup')}
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => joinCreditGroup(joinId));
          }}
        >
          <Field id="credit-group-join" label={t('credit.joinGroupLabel')}>
            <TextInput
              id="credit-group-join"
              value={joinId}
              onChange={(event) => setJoinId(event.target.value)}
            />
          </Field>
          <button type="submit" className="button" disabled={pending || !joinId.trim()}>
            {pending ? t('credit.joining') : t('credit.joinGroup')}
          </button>
        </form>
        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}
      </div>
    </QueryState>
  );
}

/* --------------------------------- savings ------------------------------- */

export function CreditSavingsSection() {
  const { hydrated } = useAppState();
  const { t } = useT();
  const account = useApiQuery(
    hydrated ? 'credit:savings:mine' : null,
    () => fetchOwnSavingsAccount().then((res) => res.data),
    { enabled: hydrated }
  );
  const transactions = useApiQuery(
    hydrated ? 'credit:savings:mine:txns' : null,
    () => fetchOwnSavingsTransactions().then((res) => res.data),
    { enabled: hydrated }
  );
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function transact(direction: 'deposit' | 'withdrawal') {
    const amountKobo = nairaToKobo(amount);
    if (amountKobo === null) {
      setError('Enter a valid amount.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const ref = `web-${direction}-${crypto.randomUUID()}`;
      if (direction === 'deposit') {
        await depositOwnSavings(amountKobo, ref);
      } else {
        await withdrawOwnSavings(amountKobo, ref);
      }
      setAmount('');
      account.refresh();
      transactions.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Savings transaction failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <QueryState
      isLoading={account.isLoading}
      error={account.error}
      data={account.data}
      onRetry={account.refresh}
    >
      {account.data ? (
        <div className="stack">
          <Card title={t('credit.balanceLabel')}>
            <div className="metric-value" aria-label={`Savings balance ${account.data.balanceKobo} kobo`}>
              {formatKobo(account.data.balanceKobo)}
            </div>
          </Card>
          <div className="cluster">
            <Field id="credit-savings-amount" label={t('credit.depositLabel')}>
              <TextInput
                id="credit-savings-amount"
                inputMode="numeric"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="button button-primary"
              disabled={pending}
              onClick={() => void transact('deposit')}
            >
              {pending ? t('credit.saving') : t('credit.deposit')}
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => void transact('withdrawal')}
            >
              {pending ? t('credit.saving') : t('credit.withdraw')}
            </button>
          </div>
          <p className="small muted">{t('credit.refNote')}</p>
          {error ? (
            <p role="alert" className="notice notice-error">
              {error}
            </p>
          ) : null}
          <h3 className="small">{t('credit.transactionsTitle')}</h3>
          {transactions.data && transactions.data.length === 0 ? (
            <EmptyState title={t('credit.transactionsEmpty')} />
          ) : null}
          {transactions.data && transactions.data.length > 0 ? (
            <ul className="stack">
              {transactions.data.map((txn) => (
                <li key={txn.id} className="cluster" style={{ justifyContent: 'space-between' }}>
                  <span className="small">
                    {txn.direction} · {formatKobo(txn.amountKobo)}
                  </span>
                  <span className="small muted">{txn.ref}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
}

/* ------------------------------ score preview ---------------------------- */

export function CreditScorePreviewSection() {
  const { userId, hydrated } = useAppState();
  const { t } = useT();
  const query = useApiQuery(
    hydrated ? `credit:score:${userId}` : null,
    () => fetchCreditScoreAssessment(userId).then((res) => res.data),
    { enabled: hydrated }
  );
  const FACTOR_LABELS: Record<string, string> = {
    repaymentHistory: t('credit.factorRepayment'),
    profileCompleteness: t('credit.factorProfile'),
    transactionVolume: t('credit.factorVolume'),
    guarantorStrength: t('credit.factorGuarantor'),
    groupStanding: t('credit.factorGroup')
  };
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data ? (
        <Card title={t('credit.scoreTitle')}>
          <div
            className="metric-value"
            aria-label={`Credit score ${query.data.score} out of 1000`}
          >
            {query.data.score}
            <span className="small muted"> / 1000</span>
          </div>
          <ul className="stack">
            {Object.entries(query.data.factors).map(([factor, value]) => (
              <li key={factor} className="cluster" style={{ justifyContent: 'space-between' }}>
                <span className="small">{FACTOR_LABELS[factor] ?? factor}</span>
                <span className="small" style={{ fontWeight: 700 }}>
                  {value}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </QueryState>
  );
}
