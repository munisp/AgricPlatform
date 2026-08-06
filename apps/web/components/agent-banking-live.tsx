'use client';

import { useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  approveTopUp,
  fetchAgentCommissionStatement,
  fetchAgentFloat,
  fetchAgentTopUps,
  fetchAgentTransactions,
  fetchAgentVouchers,
  fetchMyAgentProfile,
  fetchTopUpQueue,
  issueAgentVoucher,
  redeemAgentVoucher,
  rejectTopUp,
  requestAgentTopUp,
  settleTopUp,
  type AgentBankingAgent,
  type AgentTopUpStatus,
  type AgentTransactionType,
  type AgentVoucherStatus
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { Field, Select, TextInput } from '@/components/forms';
import { QueryState } from '@/components/api-state';
import { Card, EmptyState, ProgressBar, StatusBadge, formatKobo } from '@/components/ui';

const TOPUP_TONES: Record<AgentTopUpStatus, 'success' | 'warning' | 'critical' | 'neutral'> = {
  REQUESTED: 'warning',
  APPROVED: 'neutral',
  SETTLED: 'success',
  REJECTED: 'critical'
};

const VOUCHER_TONES: Record<AgentVoucherStatus, 'success' | 'warning' | 'critical' | 'neutral'> = {
  ISSUED: 'warning',
  REDEEMED: 'success',
  EXPIRED: 'neutral',
  VOIDED: 'critical'
};

function nairaToKobo(naira: string): number | null {
  const value = Number(naira);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function useAgentProfile() {
  return useApiQuery('agent-banking:me', () => fetchMyAgentProfile().then((res) => res.data));
}

/** Shared "not an agent" body shown when agents/me 404s. */
function NotAgentCard() {
  const { t } = useT();
  return (
    <Card title={t('agentBanking.notAgentTitle')}>
      <p className="small muted">{t('agentBanking.notAgentBody')}</p>
    </Card>
  );
}

/* ---------------------------- float dashboard ---------------------------- */

export function AgentFloatSection() {
  const { t } = useT();
  const profile = useAgentProfile();
  const agentId = profile.data?.id ?? null;
  const float = useApiQuery(agentId ? `agent-banking:float:${agentId}` : null, () =>
    fetchAgentFloat(agentId as string).then((res) => res.data)
  );

  if (profile.error) {
    return <NotAgentCard />;
  }
  return (
    <QueryState isLoading={profile.isLoading || float.isLoading} error={float.error} data={float.data} onRetry={float.refresh}>
      {float.data ? (
        <Card title={t('agentBanking.floatTitle')}>
          <p className="metric-value" data-testid="float-balance">
            {formatKobo(float.data.balanceKobo)}
          </p>
          <ProgressBar
            value={Math.min(
              100,
              float.data.lowFloatThresholdKobo > 0
                ? Math.round((float.data.balanceKobo / (float.data.lowFloatThresholdKobo * 5)) * 100)
                : 100
            )}
            label={`${t('agentBanking.floatLimitLabel')}: ${formatKobo(float.data.lowFloatThresholdKobo)}`}
          />
          {float.data.lowFloat ? (
            <p role="alert" className="notice">
              {t('agentBanking.lowFloatAlert')}
            </p>
          ) : null}
        </Card>
      ) : null}
    </QueryState>
  );
}

/* ------------------------- top-up request (agent) ------------------------ */

export function AgentTopUpSection() {
  const { t } = useT();
  const profile = useAgentProfile();
  const agentId = profile.data?.id ?? null;
  const topUps = useApiQuery(agentId ? `agent-banking:topups:${agentId}` : null, () =>
    fetchAgentTopUps(agentId as string).then((res) => res.data)
  );
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const request = useApiMutation<number, unknown>({
    mutationFn: async (amountKobo) => {
      if (!agentId) throw new Error('No agent profile');
      return requestAgentTopUp(agentId, amountKobo);
    },
    onSuccess: () => {
      setNotice(t('agentBanking.topUpRequestedNotice'));
      setAmount('');
      topUps.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  if (profile.error) {
    return <NotAgentCard />;
  }
  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          const amountKobo = nairaToKobo(amount);
          if (amountKobo === null) {
            setError(t('agentBanking.topUpAmountLabel'));
            return;
          }
          void request.mutate(amountKobo);
        }}
      >
        <Field label={t('agentBanking.topUpAmountLabel')} id="topup-amount">
          <TextInput
            id="topup-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={request.status === 'pending' || !agentId}>
          {request.status === 'pending' ? t('agentBanking.topUpWorking') : t('agentBanking.topUpAction')}
        </button>
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="notice notice-success">
            {notice}
          </p>
        ) : null}
      </form>
      <QueryState
        isLoading={topUps.isLoading}
        error={topUps.error}
        data={topUps.data}
        onRetry={topUps.refresh}
        empty={<EmptyState title={t('agentBanking.topUpEmpty')} />}
      >
        {topUps.data && topUps.data.length > 0 ? (
          <ul >
            {topUps.data.map((topUp) => (
              <li key={topUp.id}>
                {formatKobo(topUp.amountKobo)} · {topUp.createdAt.slice(0, 10)}{' '}
                <StatusBadge tone={TOPUP_TONES[topUp.status]}>{topUp.status}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>
    </div>
  );
}

/* --------------------- supervisor approval queue (admin) ------------------ */

export function AgentTopUpQueueSection() {
  const { t } = useT();
  const queue = useApiQuery('agent-banking:topup-queue', () =>
    fetchTopUpQueue('REQUESTED').then((res) => res.data)
  );
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      queue.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <QueryState
      isLoading={queue.isLoading}
      error={queue.error}
      data={queue.data}
      onRetry={queue.refresh}
      empty={<EmptyState title={t('agentBanking.queueEmpty')} />}
    >
      {queue.data && queue.data.length > 0 ? (
        <ul >
          {queue.data.map((topUp) => (
            <li key={topUp.id} data-testid={`topup-${topUp.id}`}>
              <strong>{formatKobo(topUp.amountKobo)}</strong> · agent {topUp.agentId} ·{' '}
              {topUp.createdAt.slice(0, 10)}{' '}
              <StatusBadge tone={TOPUP_TONES[topUp.status]}>{topUp.status}</StatusBadge>
              <div className="cluster">
                <button
                  type="button"
                  disabled={busy === topUp.id}
                  onClick={() => void run(topUp.id, () => approveTopUp(topUp.id))}
                >
                  {t('agentBanking.approveAction')}
                </button>
                <button
                  type="button"
                  disabled={busy === topUp.id}
                  onClick={() => void run(topUp.id, () => settleTopUp(topUp.id))}
                >
                  {t('agentBanking.settleAction')}
                </button>
                <TextInput
                  aria-label={t('agentBanking.rejectReasonLabel')}
                  placeholder={t('agentBanking.rejectReasonLabel')}
                  value={reason[topUp.id] ?? ''}
                  onChange={(event) =>
                    setReason((current) => ({ ...current, [topUp.id]: event.target.value }))
                  }
                />
                <button
                  type="button"
                  disabled={busy === topUp.id || !(reason[topUp.id] ?? '').trim()}
                  onClick={() =>
                    void run(topUp.id, () => rejectTopUp(topUp.id, (reason[topUp.id] ?? '').trim()))
                  }
                >
                  {t('agentBanking.rejectAction')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="notice">
          {error}
        </p>
      ) : null}
    </QueryState>
  );
}

/* ----------------------------- transaction log --------------------------- */

const TX_TYPES: AgentTransactionType[] = ['cash_in', 'cash_out', 'voucher_redemption'];

export function AgentTransactionLogSection() {
  const { t } = useT();
  const profile = useAgentProfile();
  const agentId = profile.data?.id ?? null;
  const [type, setType] = useState<AgentTransactionType | ''>('');
  const txs = useApiQuery(agentId ? `agent-banking:txs:${agentId}:${type}` : null, () =>
    fetchAgentTransactions(agentId as string, { type: type || undefined }).then((res) => res.data)
  );

  if (profile.error) {
    return <NotAgentCard />;
  }
  return (
    <div>
      <Field label={t('agentBanking.transactionsTitle')} id="tx-filter">
        <Select
          id="tx-filter"
          value={type}
          onChange={(event) => setType(event.target.value as AgentTransactionType | '')}
        >
          <option value="">{t('agentBanking.filterAll')}</option>
          {TX_TYPES.map((txType) => (
            <option key={txType} value={txType}>
              {txType === 'cash_in'
                ? t('agentBanking.filterCashIn')
                : txType === 'cash_out'
                  ? t('agentBanking.filterCashOut')
                  : t('agentBanking.filterVoucher')}
            </option>
          ))}
        </Select>
      </Field>
      <QueryState
        isLoading={txs.isLoading}
        error={txs.error}
        data={txs.data}
        onRetry={txs.refresh}
        empty={<EmptyState title={t('agentBanking.transactionsEmpty')} />}
      >
        {txs.data && txs.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('agentBanking.colDate')}</th>
                <th>{t('agentBanking.colType')}</th>
                <th>{t('agentBanking.colAmount')}</th>
                <th>{t('agentBanking.colCommission')}</th>
              </tr>
            </thead>
            <tbody>
              {txs.data.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.createdAt.slice(0, 10)}</td>
                  <td>{tx.type}</td>
                  <td>{formatKobo(tx.amountKobo)}</td>
                  <td>{formatKobo(tx.commissionKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueryState>
    </div>
  );
}

/* ------------------------------- vouchers -------------------------------- */

export function AgentVoucherSection() {
  const { t } = useT();
  const profile = useAgentProfile();
  const agentId = profile.data?.id ?? null;
  const vouchers = useApiQuery(agentId ? `agent-banking:vouchers:${agentId}` : null, () =>
    fetchAgentVouchers(agentId as string).then((res) => res.data)
  );
  const [farmerId, setFarmerId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  const issue = useApiMutation<{ farmerId: string; amountKobo: number }, { signature: string; id: string }>({
    mutationFn: async (input) => {
      if (!agentId) throw new Error('No agent profile');
      const res = await issueAgentVoucher(agentId, input);
      return res.data;
    },
    onSuccess: (voucher) => {
      setIssued(`${voucher.id} · ${voucher.signature}`);
      setFarmerId('');
      setAmount('');
      vouchers.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  if (profile.error) {
    return <NotAgentCard />;
  }
  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setIssued(null);
          const amountKobo = nairaToKobo(amount);
          if (!farmerId.trim() || amountKobo === null) {
            setError(t('agentBanking.voucherFarmerLabel'));
            return;
          }
          void issue.mutate({ farmerId: farmerId.trim(), amountKobo });
        }}
      >
        <Field label={t('agentBanking.voucherFarmerLabel')} id="voucher-farmer">
          <TextInput
            id="voucher-farmer"
            value={farmerId}
            onChange={(event) => setFarmerId(event.target.value)}
          />
        </Field>
        <Field label={t('agentBanking.voucherAmountLabel')} id="voucher-amount">
          <TextInput
            id="voucher-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={issue.status === 'pending' || !agentId}>
          {issue.status === 'pending' ? t('agentBanking.working') : t('agentBanking.voucherIssueAction')}
        </button>
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
        {issued ? (
          <p role="status" className="notice notice-success" data-testid="voucher-issued">
            {t('agentBanking.voucherIssuedNotice')} {issued}
          </p>
        ) : null}
      </form>
      <QueryState
        isLoading={vouchers.isLoading}
        error={vouchers.error}
        data={vouchers.data}
        onRetry={vouchers.refresh}
        empty={<EmptyState title={t('agentBanking.voucherListEmpty')} />}
      >
        {vouchers.data && vouchers.data.length > 0 ? (
          <ul >
            {vouchers.data.map((voucher) => (
              <li key={voucher.id}>
                {voucher.id} · {formatKobo(voucher.amountKobo)} ·{' '}
                {t('agentBanking.colStatus')}{' '}
                <StatusBadge tone={VOUCHER_TONES[voucher.status]}>{voucher.status}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>
    </div>
  );
}

export function AgentVoucherRedeemSection() {
  const { t } = useT();
  const [code, setCode] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redeem = useApiMutation<{ id: string; signature?: string }, unknown>({
    mutationFn: async (input) => redeemAgentVoucher(input.id, input.signature),
    onSuccess: () => {
      setNotice(t('agentBanking.redeemedNotice'));
      setCode('');
      setSignature('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setNotice(null);
        if (!code.trim()) {
          setError(t('agentBanking.redeemCodeLabel'));
          return;
        }
        void redeem.mutate({ id: code.trim(), signature: signature.trim() || undefined });
      }}
    >
      <Field label={t('agentBanking.redeemCodeLabel')} id="redeem-code">
        <TextInput id="redeem-code" value={code} onChange={(event) => setCode(event.target.value)} />
      </Field>
      <Field label={t('agentBanking.redeemSignatureLabel')} id="redeem-signature">
        <TextInput
          id="redeem-signature"
          value={signature}
          onChange={(event) => setSignature(event.target.value)}
        />
      </Field>
      <button type="submit" disabled={redeem.status === 'pending'}>
        {redeem.status === 'pending' ? t('agentBanking.working') : t('agentBanking.redeemAction')}
      </button>
      {error ? (
        <p role="alert" className="notice">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice notice-success">
          {notice}
        </p>
      ) : null}
    </form>
  );
}

/* ------------------------------ commissions ------------------------------ */

export function AgentCommissionSection() {
  const { t } = useT();
  const profile = useAgentProfile();
  const agentId = profile.data?.id ?? null;
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const statement = useApiQuery(agentId ? `agent-banking:commissions:${agentId}:${month}` : null, () =>
    fetchAgentCommissionStatement(agentId as string, month).then((res) => res.data)
  );

  if (profile.error) {
    return <NotAgentCard />;
  }
  return (
    <div>
      <Field label={t('agentBanking.commissionsTitle')} id="commission-month">
        <TextInput
          id="commission-month"
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </Field>
      <QueryState
        isLoading={statement.isLoading}
        error={statement.error}
        data={statement.data}
        onRetry={statement.refresh}
      >
        {statement.data && statement.data.rows.length === 0 ? (
          <EmptyState title={t('agentBanking.commissionsEmpty')} />
        ) : null}
        {statement.data && statement.data.rows.length > 0 ? (
          <div>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('agentBanking.colType')}</th>
                  <th>{t('agentBanking.colCount')}</th>
                  <th>{t('agentBanking.colVolume')}</th>
                  <th>{t('agentBanking.colCommission')}</th>
                </tr>
              </thead>
              <tbody>
                {statement.data.rows.map((row) => (
                  <tr key={row.type}>
                    <td>{row.type}</td>
                    <td>{row.count}</td>
                    <td>{formatKobo(row.volumeKobo)}</td>
                    <td>{formatKobo(row.commissionKobo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small" data-testid="commission-total">
              {t('agentBanking.commissionTotalLabel')}: {formatKobo(statement.data.totalCommissionKobo)} ·{' '}
              {t('agentBanking.commissionPayableLabel')}: {formatKobo(statement.data.commissionPayableKobo)}
            </p>
          </div>
        ) : null}
      </QueryState>
    </div>
  );
}

export type { AgentBankingAgent };
