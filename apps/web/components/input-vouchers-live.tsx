'use client';

import { useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  activateSubsidyProgramme,
  allocateSubsidyVoucher,
  createSubsidyProgramme,
  distributeSubsidyVoucher,
  fetchMySubsidyVouchers,
  fetchProgrammeVouchers,
  fetchSubsidyProgrammes,
  fetchSubsidyReconciliation,
  redeemSubsidyVoucher,
  verifySubsidyBeneficiary,
  type SubsidyBeneficiary,
  type SubsidyProgrammeStatus,
  type SubsidyVoucherStatus
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { Field, Select, TextInput } from '@/components/forms';
import { QueryState } from '@/components/api-state';
import { Card, EmptyState, StatusBadge, formatKobo } from '@/components/ui';

const PROGRAMME_TONES: Record<SubsidyProgrammeStatus, 'success' | 'warning' | 'critical' | 'neutral'> = {
  DRAFT: 'warning',
  ACTIVE: 'success',
  CLOSED: 'neutral'
};

const VOUCHER_TONES: Record<SubsidyVoucherStatus, 'success' | 'warning' | 'critical' | 'neutral'> = {
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

/** Honest STUB provenance badge — shown wherever identity data is touched. */
export function StubIdentityBadge() {
  const { t } = useT();
  return (
    <span>
      <StatusBadge tone="warning">{t('inputVouchers.stubBadge')}</StatusBadge>{' '}
      <span className="small muted">{t('inputVouchers.stubNote')}</span>
    </span>
  );
}

function useProgrammes() {
  return useApiQuery('input-vouchers:programmes', () =>
    fetchSubsidyProgrammes().then((res) => res.data)
  );
}

/* ------------------------- programme administration ------------------------ */

export function SubsidyProgrammeSection() {
  const { t } = useT();
  const programmes = useProgrammes();
  const [name, setName] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [cap, setCap] = useState('');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const create = useApiMutation<
    { name: string; sponsor: string; perFarmerCapKobo: number; budgetKobo: number },
    unknown
  >({
    mutationFn: (input) => createSubsidyProgramme(input),
    onSuccess: () => {
      setNotice(t('inputVouchers.createdNotice'));
      setName('');
      setSponsor('');
      setCap('');
      setBudget('');
      programmes.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  async function activate(id: string) {
    setBusy(id);
    setError(null);
    try {
      await activateSubsidyProgramme(id);
      setNotice(t('inputVouchers.activatedNotice'));
      programmes.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <StubIdentityBadge />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          const perFarmerCapKobo = nairaToKobo(cap);
          const budgetKobo = nairaToKobo(budget);
          if (!name.trim() || !sponsor.trim() || perFarmerCapKobo === null || budgetKobo === null) {
            setError(t('inputVouchers.programmeNameLabel'));
            return;
          }
          void create.mutate({ name: name.trim(), sponsor: sponsor.trim(), perFarmerCapKobo, budgetKobo });
        }}
      >
        <Field label={t('inputVouchers.programmeNameLabel')} id="prog-name">
          <TextInput id="prog-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.sponsorLabel')} id="prog-sponsor">
          <TextInput id="prog-sponsor" value={sponsor} onChange={(event) => setSponsor(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.capLabel')} id="prog-cap">
          <TextInput id="prog-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.budgetLabel')} id="prog-budget">
          <TextInput
            id="prog-budget"
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={create.status === 'pending'}>
          {create.status === 'pending' ? t('inputVouchers.working') : t('inputVouchers.createAction')}
        </button>
      </form>
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
      <QueryState
        isLoading={programmes.isLoading}
        error={programmes.error}
        data={programmes.data}
        onRetry={programmes.refresh}
        empty={<EmptyState title={t('inputVouchers.programmesEmpty')} />}
      >
        {programmes.data && programmes.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('inputVouchers.programmeNameLabel')}</th>
                <th>{t('inputVouchers.colSponsor')}</th>
                <th>{t('inputVouchers.colCap')}</th>
                <th>{t('inputVouchers.colBudget')}</th>
                <th>{t('inputVouchers.colStatus')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {programmes.data.map((programme) => (
                <tr key={programme.id} data-testid={`programme-${programme.id}`}>
                  <td>{programme.name}</td>
                  <td>{programme.sponsor}</td>
                  <td>{formatKobo(programme.perFarmerCapKobo)}</td>
                  <td>{formatKobo(programme.budgetKobo)}</td>
                  <td>
                    <StatusBadge tone={PROGRAMME_TONES[programme.status]}>{programme.status}</StatusBadge>
                  </td>
                  <td>
                    {programme.status === 'DRAFT' ? (
                      <button type="button" disabled={busy === programme.id} onClick={() => void activate(programme.id)}>
                        {t('inputVouchers.activateAction')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueryState>
    </div>
  );
}

/* ------------------------------ NIN enrolment ------------------------------ */

export function BeneficiaryEnrolSection() {
  const { t } = useT();
  const programmes = useProgrammes();
  const [programmeId, setProgrammeId] = useState('');
  const [farmerId, setFarmerId] = useState('');
  const [nin, setNin] = useState('');
  const [fullName, setFullName] = useState('');
  const [state, setState] = useState('');
  const [crop, setCrop] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<SubsidyBeneficiary | null>(null);

  const enrol = useApiMutation<
    { farmerId: string; nin: string; fullName: string; state?: string; primaryCrop?: string },
    SubsidyBeneficiary
  >({
    mutationFn: async (input) => {
      if (!programmeId) throw new Error('No programme selected');
      const res = await verifySubsidyBeneficiary(programmeId, input);
      return res.data;
    },
    onSuccess: (beneficiary) => {
      setEnrolled(beneficiary);
      setNin('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <Card title={t('inputVouchers.enrolTitle')}>
      <StubIdentityBadge />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setEnrolled(null);
          if (!programmeId || !farmerId.trim() || !nin.trim() || !fullName.trim()) {
            setError(t('inputVouchers.ninLabel'));
            return;
          }
          void enrol.mutate({
            farmerId: farmerId.trim(),
            nin: nin.trim(),
            fullName: fullName.trim(),
            state: state.trim() || undefined,
            primaryCrop: crop.trim() || undefined
          });
        }}
      >
        <Field label={t('inputVouchers.enrolProgrammeLabel')} id="enrol-programme">
          <Select id="enrol-programme" value={programmeId} onChange={(event) => setProgrammeId(event.target.value)}>
            <option value="">{t('inputVouchers.pickProgramme')}</option>
            {(programmes.data ?? []).map((programme) => (
              <option key={programme.id} value={programme.id}>
                {programme.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inputVouchers.farmerIdLabel')} id="enrol-farmer">
          <TextInput id="enrol-farmer" value={farmerId} onChange={(event) => setFarmerId(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.ninLabel')} id="enrol-nin">
          <TextInput id="enrol-nin" inputMode="numeric" value={nin} onChange={(event) => setNin(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.fullNameLabel')} id="enrol-name">
          <TextInput id="enrol-name" value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.stateLabel')} id="enrol-state">
          <TextInput id="enrol-state" value={state} onChange={(event) => setState(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.cropLabel')} id="enrol-crop">
          <TextInput id="enrol-crop" value={crop} onChange={(event) => setCrop(event.target.value)} />
        </Field>
        <button type="submit" disabled={enrol.status === 'pending'}>
          {enrol.status === 'pending' ? t('inputVouchers.working') : t('inputVouchers.enrolAction')}
        </button>
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
        {enrolled ? (
          <p role="status" className="notice notice-success" data-testid="beneficiary-enrolled">
            {t('inputVouchers.enrolledNotice')} {t('inputVouchers.ninMaskLabel')}: {enrolled.ninMask} ·{' '}
            {t('inputVouchers.basisLabel')}: <StatusBadge tone="warning">{enrolled.verificationBasis}</StatusBadge>
          </p>
        ) : null}
      </form>
    </Card>
  );
}

/* ------------------------------ allocation -------------------------------- */

export function VoucherAllocateSection() {
  const { t } = useT();
  const programmes = useProgrammes();
  const [programmeId, setProgrammeId] = useState('');
  const vouchers = useApiQuery(programmeId ? `input-vouchers:programme-vouchers:${programmeId}` : null, () =>
    fetchProgrammeVouchers(programmeId).then((res) => res.data)
  );
  const [farmerId, setFarmerId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const allocate = useApiMutation<{ farmerId: string; amountKobo: number; idempotencyKey: string }, unknown>({
    mutationFn: async (input) => {
      if (!programmeId) throw new Error('No programme selected');
      return allocateSubsidyVoucher(programmeId, input);
    },
    onSuccess: () => {
      setNotice(t('inputVouchers.allocatedNotice'));
      setFarmerId('');
      setAmount('');
      vouchers.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  async function distribute(id: string) {
    setBusy(id);
    setError(null);
    try {
      await distributeSubsidyVoucher(id);
      setNotice(t('inputVouchers.distributedNotice'));
      vouchers.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          const amountKobo = nairaToKobo(amount);
          if (!programmeId || !farmerId.trim() || amountKobo === null) {
            setError(t('inputVouchers.amountLabel'));
            return;
          }
          void allocate.mutate({
            farmerId: farmerId.trim(),
            amountKobo,
            idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
          });
        }}
      >
        <Field label={t('inputVouchers.enrolProgrammeLabel')} id="alloc-programme">
          <Select id="alloc-programme" value={programmeId} onChange={(event) => setProgrammeId(event.target.value)}>
            <option value="">{t('inputVouchers.pickProgramme')}</option>
            {(programmes.data ?? [])
              .filter((programme) => programme.status === 'ACTIVE')
              .map((programme) => (
                <option key={programme.id} value={programme.id}>
                  {programme.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={t('inputVouchers.farmerIdLabel')} id="alloc-farmer">
          <TextInput id="alloc-farmer" value={farmerId} onChange={(event) => setFarmerId(event.target.value)} />
        </Field>
        <Field label={t('inputVouchers.amountLabel')} id="alloc-amount">
          <TextInput
            id="alloc-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={allocate.status === 'pending' || !programmeId}>
          {allocate.status === 'pending' ? t('inputVouchers.working') : t('inputVouchers.allocateAction')}
        </button>
      </form>
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
      <QueryState
        isLoading={vouchers.isLoading}
        error={vouchers.error}
        data={vouchers.data}
        onRetry={vouchers.refresh}
        empty={<EmptyState title={t('inputVouchers.vouchersEmpty')} />}
      >
        {vouchers.data && vouchers.data.length > 0 ? (
          <ul>
            {vouchers.data.map((voucher) => (
              <li key={voucher.id} data-testid={`voucher-${voucher.id}`}>
                {voucher.id} · {formatKobo(voucher.amountKobo)}{' '}
                <StatusBadge tone={VOUCHER_TONES[voucher.status]}>{voucher.status}</StatusBadge>
                {voucher.status === 'ISSUED' && !voucher.distributedAt ? (
                  <button type="button" disabled={busy === voucher.id} onClick={() => void distribute(voucher.id)}>
                    {t('inputVouchers.distributeAction')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>
    </div>
  );
}

/* ----------------------------- farmer self-service ------------------------- */

export function FarmerVoucherSection() {
  const { t } = useT();
  const vouchers = useApiQuery('input-vouchers:mine', () =>
    fetchMySubsidyVouchers().then((res) => res.data)
  );
  return (
    <QueryState
      isLoading={vouchers.isLoading}
      error={vouchers.error}
      data={vouchers.data}
      onRetry={vouchers.refresh}
      empty={<EmptyState title={t('inputVouchers.farmerEmpty')} />}
    >
      {vouchers.data && vouchers.data.length > 0 ? (
        <ul>
          {vouchers.data.map((voucher) => (
            <li key={voucher.id} data-testid={`my-voucher-${voucher.id}`}>
              {voucher.id} · {formatKobo(voucher.amountKobo)} · {t('inputVouchers.expiresLabel')}{' '}
              {voucher.expiresAt.slice(0, 10)}{' '}
              <StatusBadge tone={VOUCHER_TONES[voucher.status]}>{voucher.status}</StatusBadge>{' '}
              <span className="small muted">
                {voucher.status === 'ISSUED'
                  ? voucher.distributedAt
                    ? t('inputVouchers.farmerDistributed')
                    : t('inputVouchers.farmerPending')
                  : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </QueryState>
  );
}

/* ------------------------------ supplier redeem ---------------------------- */

export function SupplierRedeemSection() {
  const { t } = useT();
  const [code, setCode] = useState('');
  const [invoice, setInvoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redeem = useApiMutation<{ id: string; invoiceRef: string }, unknown>({
    mutationFn: async (input) => redeemSubsidyVoucher(input.id, input.invoiceRef),
    onSuccess: () => {
      setNotice(t('inputVouchers.redeemedNotice'));
      setCode('');
      setInvoice('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setNotice(null);
        if (!code.trim() || !invoice.trim()) {
          setError(t('inputVouchers.invoiceLabel'));
          return;
        }
        void redeem.mutate({ id: code.trim(), invoiceRef: invoice.trim() });
      }}
    >
      <Field label={t('inputVouchers.redeemCodeLabel')} id="redeem-code">
        <TextInput id="redeem-code" value={code} onChange={(event) => setCode(event.target.value)} />
      </Field>
      <Field label={t('inputVouchers.invoiceLabel')} id="redeem-invoice">
        <TextInput id="redeem-invoice" value={invoice} onChange={(event) => setInvoice(event.target.value)} />
      </Field>
      <button type="submit" disabled={redeem.status === 'pending'}>
        {redeem.status === 'pending' ? t('inputVouchers.working') : t('inputVouchers.redeemAction')}
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

/* ------------------------------ reconciliation ----------------------------- */

export function SubsidyReconciliationSection() {
  const { t } = useT();
  const programmes = useProgrammes();
  const [programmeId, setProgrammeId] = useState('');
  const report = useApiQuery(programmeId ? `input-vouchers:reconciliation:${programmeId}` : null, () =>
    fetchSubsidyReconciliation(programmeId).then((res) => res.data)
  );

  return (
    <div>
      <Field label={t('inputVouchers.enrolProgrammeLabel')} id="report-programme">
        <Select id="report-programme" value={programmeId} onChange={(event) => setProgrammeId(event.target.value)}>
          <option value="">{t('inputVouchers.pickProgramme')}</option>
          {(programmes.data ?? []).map((programme) => (
            <option key={programme.id} value={programme.id}>
              {programme.name}
            </option>
          ))}
        </Select>
      </Field>
      <QueryState
        isLoading={report.isLoading}
        error={report.error}
        data={report.data}
        onRetry={report.refresh}
        empty={<EmptyState title={t('inputVouchers.vouchersEmpty')} />}
      >
        {report.data ? (
          <div data-testid="reconciliation-report">
            <table className="table">
              <tbody>
                <tr>
                  <th>{t('inputVouchers.reportBudget')}</th>
                  <td data-testid="report-budget">{formatKobo(report.data.budgetKobo)}</td>
                </tr>
                <tr>
                  <th>{t('inputVouchers.reportOutstanding')}</th>
                  <td>{formatKobo(report.data.totals.outstandingKobo)}</td>
                </tr>
                <tr>
                  <th>{t('inputVouchers.reportRedeemed')}</th>
                  <td data-testid="report-redeemed">{formatKobo(report.data.totals.redeemedKobo)}</td>
                </tr>
                <tr>
                  <th>{t('inputVouchers.reportReleased')}</th>
                  <td>{formatKobo(report.data.totals.expiredKobo + report.data.totals.voidedKobo)}</td>
                </tr>
                <tr>
                  <th>{t('inputVouchers.reportBeneficiaries')}</th>
                  <td>{report.data.totals.beneficiariesVerified}</td>
                </tr>
                <tr>
                  <th>{t('inputVouchers.reportLiability')}</th>
                  <td>{formatKobo(report.data.ledger.liabilityKobo)}</td>
                </tr>
                <tr>
                  <th>{t('inputVouchers.reportExpected')}</th>
                  <td>{formatKobo(report.data.ledger.expectedLiabilityKobo)}</td>
                </tr>
              </tbody>
            </table>
            <p
              role={report.data.ledger.discrepancyKobo === 0 ? 'status' : 'alert'}
              className={report.data.ledger.discrepancyKobo === 0 ? 'notice notice-success' : 'notice'}
              data-testid="report-tie"
            >
              {report.data.ledger.discrepancyKobo === 0
                ? t('inputVouchers.reportTieOk')
                : `${t('inputVouchers.reportTieBad')} ${formatKobo(Math.abs(report.data.ledger.discrepancyKobo))}`}
            </p>
            {report.data.byState.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('inputVouchers.colState')}</th>
                    <th>{t('inputVouchers.colCount')}</th>
                    <th>{t('inputVouchers.reportOutstanding')}</th>
                    <th>{t('inputVouchers.reportRedeemed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.byState.map((row) => (
                    <tr key={row.state}>
                      <td>{row.state}</td>
                      <td>{row.vouchersIssued}</td>
                      <td>{formatKobo(row.outstandingKobo)}</td>
                      <td>{formatKobo(row.redeemedKobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}
      </QueryState>
    </div>
  );
}
