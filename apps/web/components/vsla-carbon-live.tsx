'use client';

import { useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  closeVslaCycle,
  createVslaGroup,
  estimateCarbonPlot,
  fetchCarbonEvidence,
  fetchCarbonEstimates,
  fetchCarbonPlots,
  fetchGroupMrvReport,
  fetchProgrammeMrvReport,
  fetchVslaContributions,
  fetchVslaCycles,
  fetchVslaGroups,
  fetchVslaLoans,
  fetchVslaMembers,
  issueVslaLoan,
  openVslaCycle,
  recordVslaContribution,
  registerCarbonPlot,
  repayVslaLoan,
  submitCarbonEvidence,
  type CarbonPracticeType,
  type VslaCycleStatus,
  type VslaLoanStatus
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { downloadVslaCarbonMrvExport } from '@/lib/api/export';
import { Field, Select, TextInput } from '@/components/forms';
import { QueryState } from '@/components/api-state';
import { Card, EmptyState, StatusBadge, formatKobo } from '@/components/ui';

const CYCLE_TONES: Record<VslaCycleStatus, 'success' | 'neutral'> = {
  OPEN: 'success',
  CLOSED: 'neutral'
};

const LOAN_TONES: Record<VslaLoanStatus, 'success' | 'warning'> = {
  ACTIVE: 'warning',
  REPAID: 'success'
};

const PRACTICES: CarbonPracticeType[] = ['agroforestry', 'fmnr', 'woodlot', 'conservation_agriculture'];

function nairaToKobo(naira: string): number | null {
  const value = Number(naira);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function newKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Honest provenance badge — stub/estimate figures are never presented as verified. */
export function BasisBadge({ basis }: { basis: 'stub' | 'estimate' | 'live' }) {
  const { t } = useT();
  if (basis === 'stub') {
    return <StatusBadge tone="warning">{t('vslaCarbon.basisStub')}</StatusBadge>;
  }
  if (basis === 'estimate') {
    return <StatusBadge tone="neutral">{t('vslaCarbon.basisEstimate')}</StatusBadge>;
  }
  return <StatusBadge tone="success">{t('vslaCarbon.basisLive')}</StatusBadge>;
}

function useGroups() {
  return useApiQuery('vsla-carbon:groups', () => fetchVslaGroups().then((res) => res.data));
}

function useSelectedGroup(): [string | null, (id: string) => void] {
  const [selected, setSelected] = useState<string | null>(null);
  return [selected, setSelected];
}

/* ------------------------------ group registry ---------------------------- */

export function VslaGroupsSection({
  selectedGroupId,
  onSelect
}: {
  selectedGroupId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useT();
  const groups = useGroups();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useApiMutation<string, unknown>({
    mutationFn: async (groupName) => createVslaGroup({ name: groupName }),
    onSuccess: () => {
      setName('');
      groups.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          if (!name.trim()) {
            setError(t('vslaCarbon.groupNameLabel'));
            return;
          }
          void create.mutate(name.trim());
        }}
      >
        <Field label={t('vslaCarbon.groupNameLabel')} id="vsla-group-name">
          <TextInput
            id="vsla-group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={create.status === 'pending'}>
          {create.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.createGroupAction')}
        </button>
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
      </form>
      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        data={groups.data}
        onRetry={groups.refresh}
        empty={<EmptyState title={t('vslaCarbon.groupsEmpty')} />}
      >
        {groups.data && groups.data.length > 0 ? (
          <ul>
            {groups.data.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  className={selectedGroupId === group.id ? 'link-button active' : 'link-button'}
                  onClick={() => onSelect(group.id)}
                >
                  {group.name}
                </button>{' '}
                <StatusBadge tone={group.status === 'ACTIVE' ? 'success' : 'neutral'}>
                  {group.status}
                </StatusBadge>
                {group.chapterId ? (
                  <span className="small muted"> · {t('vslaCarbon.chapterLinked')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>
    </div>
  );
}

/* --------------------------- cycles + contributions ----------------------- */

export function VslaCycleSection({ groupId }: { groupId: string }) {
  const { t } = useT();
  const cycles = useApiQuery(`vsla-carbon:cycles:${groupId}`, () =>
    fetchVslaCycles(groupId).then((res) => res.data)
  );
  const members = useApiQuery(`vsla-carbon:members:${groupId}`, () =>
    fetchVslaMembers(groupId).then((res) => res.data)
  );
  const openCycle = cycles.data?.find((cycle) => cycle.status === 'OPEN') ?? null;
  const contributions = useApiQuery(
    openCycle ? `vsla-carbon:contributions:${openCycle.id}` : null,
    () => fetchVslaContributions((openCycle as { id: string }).id).then((res) => res.data)
  );
  const [label, setLabel] = useState('');
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = useApiMutation<string, unknown>({
    mutationFn: async (cycleLabel) => openVslaCycle(groupId, cycleLabel),
    onSuccess: () => {
      setLabel('');
      cycles.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  const contribute = useApiMutation<{ memberId: string; amountKobo: number }, unknown>({
    mutationFn: async (input) =>
      recordVslaContribution((openCycle as { id: string }).id, {
        ...input,
        idempotencyKey: newKey('web-contrib')
      }),
    onSuccess: () => {
      setAmount('');
      setNotice(t('vslaCarbon.contributionRecordedNotice'));
      contributions.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  const [shareOut, setShareOut] = useState<{ distributableKobo: number } | null>(null);

  const close = useApiMutation<string, { data: { distributableKobo: number } }>({
    mutationFn: async (cycleId) => closeVslaCycle(cycleId),
    onSuccess: (result) => {
      setShareOut({ distributableKobo: result.data.distributableKobo });
      setNotice(t('vslaCarbon.shareOutDoneNotice'));
      cycles.refresh();
      contributions.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <div>
      <QueryState
        isLoading={cycles.isLoading}
        error={cycles.error}
        data={cycles.data}
        onRetry={cycles.refresh}
        empty={<EmptyState title={t('vslaCarbon.cyclesEmpty')} />}
      >
        {cycles.data && cycles.data.length > 0 ? (
          <ul>
            {cycles.data.map((cycle) => (
              <li key={cycle.id} data-testid={`cycle-${cycle.id}`}>
                {cycle.label}{' '}
                <StatusBadge tone={CYCLE_TONES[cycle.status]}>{cycle.status}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>

      {openCycle ? (
        <div>
          <p className="small muted" data-testid="open-cycle-label">
            {t('vslaCarbon.openCycleLabel')}: {openCycle.label}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setNotice(null);
              const amountKobo = nairaToKobo(amount);
              if (!memberId || amountKobo === null) {
                setError(t('vslaCarbon.contributionInvalid'));
                return;
              }
              void contribute.mutate({ memberId, amountKobo });
            }}
          >
            <Field label={t('vslaCarbon.memberLabel')} id="vsla-contrib-member">
              <Select
                id="vsla-contrib-member"
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
              >
                <option value="">{t('vslaCarbon.memberPlaceholder')}</option>
                {(members.data ?? [])
                  .filter((member) => member.status === 'ACTIVE')
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.userId} ({member.role})
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('vslaCarbon.amountLabel')} id="vsla-contrib-amount">
              <TextInput
                id="vsla-contrib-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>
            <button type="submit" disabled={contribute.status === 'pending'}>
              {contribute.status === 'pending'
                ? t('vslaCarbon.working')
                : t('vslaCarbon.contributeAction')}
            </button>
          </form>
          <QueryState
            isLoading={contributions.isLoading}
            error={contributions.error}
            data={contributions.data}
            onRetry={contributions.refresh}
            empty={<EmptyState title={t('vslaCarbon.contributionsEmpty')} />}
          >
            {contributions.data && contributions.data.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('vslaCarbon.colMember')}</th>
                    <th>{t('vslaCarbon.colAmount')}</th>
                    <th>{t('vslaCarbon.colDate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {contributions.data.map((row) => (
                    <tr key={row.id}>
                      <td>{row.memberId}</td>
                      <td>{formatKobo(row.amountKobo)}</td>
                      <td>{row.createdAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </QueryState>
          <button
            type="button"
            data-testid="close-cycle"
            disabled={close.status === 'pending'}
            onClick={() => {
              setError(null);
              if (openCycle) {
                void close.mutate(openCycle.id);
              }
            }}
          >
            {close.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.closeCycleAction')}
          </button>
          {shareOut ? (
            <p role="status" className="notice notice-success" data-testid="share-out-total">
              {t('vslaCarbon.shareOutTotalLabel')}: {formatKobo(shareOut.distributableKobo)}
            </p>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (!label.trim()) {
              setError(t('vslaCarbon.cycleLabelLabel'));
              return;
            }
            void open.mutate(label.trim());
          }}
        >
          <Field label={t('vslaCarbon.cycleLabelLabel')} id="vsla-cycle-label">
            <TextInput
              id="vsla-cycle-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <button type="submit" disabled={open.status === 'pending'}>
            {open.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.openCycleAction')}
          </button>
        </form>
      )}
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
    </div>
  );
}

/* ----------------------------------- loans -------------------------------- */

export function VslaLoansSection({ groupId }: { groupId: string }) {
  const { t } = useT();
  const loans = useApiQuery(`vsla-carbon:loans:${groupId}`, () =>
    fetchVslaLoans(groupId).then((res) => res.data)
  );
  const members = useApiQuery(`vsla-carbon:loan-members:${groupId}`, () =>
    fetchVslaMembers(groupId).then((res) => res.data)
  );
  const [memberId, setMemberId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [ratePct, setRatePct] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const issue = useApiMutation<{ memberId: string; principalKobo: number; bps: number }, unknown>({
    mutationFn: async (input) =>
      issueVslaLoan(groupId, {
        memberId: input.memberId,
        principalKobo: input.principalKobo,
        interestRateBps: input.bps
      }),
    onSuccess: () => {
      setPrincipal('');
      setRatePct('');
      setNotice(t('vslaCarbon.loanIssuedNotice'));
      loans.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  async function repay(loanId: string, totalDueKobo: number) {
    setError(null);
    try {
      await repayVslaLoan(loanId, {
        amountKobo: totalDueKobo,
        idempotencyKey: newKey('web-repay')
      });
      setNotice(t('vslaCarbon.loanRepaidNotice'));
      loans.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          const principalKobo = nairaToKobo(principal);
          const pct = Number(ratePct);
          if (!memberId || principalKobo === null || !Number.isFinite(pct) || pct < 0 || pct > 30) {
            setError(t('vslaCarbon.loanInvalid'));
            return;
          }
          void issue.mutate({ memberId, principalKobo, bps: Math.round(pct * 100) });
        }}
      >
        <Field label={t('vslaCarbon.borrowerLabel')} id="vsla-loan-member">
          <Select
            id="vsla-loan-member"
            value={memberId}
            onChange={(event) => setMemberId(event.target.value)}
          >
            <option value="">{t('vslaCarbon.memberPlaceholder')}</option>
            {(members.data ?? [])
              .filter((member) => member.status === 'ACTIVE')
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.userId}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={t('vslaCarbon.principalLabel')} id="vsla-loan-principal">
          <TextInput
            id="vsla-loan-principal"
            inputMode="decimal"
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
          />
        </Field>
        <Field label={t('vslaCarbon.rateLabel')} id="vsla-loan-rate">
          <TextInput
            id="vsla-loan-rate"
            inputMode="decimal"
            value={ratePct}
            onChange={(event) => setRatePct(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={issue.status === 'pending'}>
          {issue.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.issueLoanAction')}
        </button>
      </form>
      <QueryState
        isLoading={loans.isLoading}
        error={loans.error}
        data={loans.data}
        onRetry={loans.refresh}
        empty={<EmptyState title={t('vslaCarbon.loansEmpty')} />}
      >
        {loans.data && loans.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('vslaCarbon.colMember')}</th>
                <th>{t('vslaCarbon.colPrincipal')}</th>
                <th>{t('vslaCarbon.colDue')}</th>
                <th>{t('vslaCarbon.colRepaid')}</th>
                <th>{t('vslaCarbon.colStatus')}</th>
                <th aria-label={t('vslaCarbon.repayAction')} />
              </tr>
            </thead>
            <tbody>
              {loans.data.map((loan) => (
                <tr key={loan.id} data-testid={`loan-${loan.id}`}>
                  <td>{loan.memberId}</td>
                  <td>{formatKobo(loan.principalKobo)}</td>
                  <td>{formatKobo(loan.totalDueKobo)}</td>
                  <td>{formatKobo(loan.repaidKobo)}</td>
                  <td>
                    <StatusBadge tone={LOAN_TONES[loan.status]}>{loan.status}</StatusBadge>
                  </td>
                  <td>
                    {loan.status === 'ACTIVE' ? (
                      <button type="button" onClick={() => void repay(loan.id, loan.totalDueKobo - loan.repaidKobo)}>
                        {t('vslaCarbon.repayAction')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueryState>
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
    </div>
  );
}

/* --------------------------- carbon plots + evidence ---------------------- */

export function CarbonPlotsSection({ groupId }: { groupId: string }) {
  const { t } = useT();
  const plots = useApiQuery(`vsla-carbon:plots:${groupId}`, () =>
    fetchCarbonPlots(groupId).then((res) => res.data)
  );
  const [name, setName] = useState('');
  const [practice, setPractice] = useState<CarbonPracticeType>('fmnr');
  const [hectares, setHectares] = useState('');
  const [lat, setLat] = useState('');
  const [long, setLong] = useState('');
  const [error, setError] = useState<string | null>(null);

  const register = useApiMutation<Parameters<typeof registerCarbonPlot>[0], unknown>({
    mutationFn: async (input) => registerCarbonPlot(input),
    onSuccess: () => {
      setName('');
      setHectares('');
      plots.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          const ha = Number(hectares);
          const latitude = Number(lat);
          const longitude = Number(long);
          if (
            !name.trim() ||
            !Number.isFinite(ha) ||
            ha <= 0 ||
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude)
          ) {
            setError(t('vslaCarbon.plotInvalid'));
            return;
          }
          void register.mutate({
            groupId,
            name: name.trim(),
            practiceType: practice,
            hectares: ha,
            centroidLat: latitude,
            centroidLong: longitude
          });
        }}
      >
        <Field label={t('vslaCarbon.plotNameLabel')} id="carbon-plot-name">
          <TextInput
            id="carbon-plot-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t('vslaCarbon.practiceLabel')} id="carbon-plot-practice">
          <Select
            id="carbon-plot-practice"
            value={practice}
            onChange={(event) => setPractice(event.target.value as CarbonPracticeType)}
          >
            {PRACTICES.map((option) => (
              <option key={option} value={option}>
                {t(`vslaCarbon.practice.${option}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('vslaCarbon.hectaresLabel')} id="carbon-plot-hectares">
          <TextInput
            id="carbon-plot-hectares"
            inputMode="decimal"
            value={hectares}
            onChange={(event) => setHectares(event.target.value)}
          />
        </Field>
        <Field label={t('vslaCarbon.latLabel')} id="carbon-plot-lat">
          <TextInput
            id="carbon-plot-lat"
            inputMode="decimal"
            value={lat}
            onChange={(event) => setLat(event.target.value)}
          />
        </Field>
        <Field label={t('vslaCarbon.longLabel')} id="carbon-plot-long">
          <TextInput
            id="carbon-plot-long"
            inputMode="decimal"
            value={long}
            onChange={(event) => setLong(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={register.status === 'pending'}>
          {register.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.registerPlotAction')}
        </button>
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
      </form>
      <QueryState
        isLoading={plots.isLoading}
        error={plots.error}
        data={plots.data}
        onRetry={plots.refresh}
        empty={<EmptyState title={t('vslaCarbon.plotsEmpty')} />}
      >
        {plots.data && plots.data.length > 0 ? (
          <ul>
            {plots.data.map((plot) => (
              <li key={plot.id} data-testid={`plot-${plot.id}`}>
                {plot.name} · {t(`vslaCarbon.practice.${plot.practiceType}`)} ·{' '}
                {(plot.hectaresCenti / 100).toFixed(2)} ha · H3 {plot.h3Res9}{' '}
                <BasisBadge basis="estimate" />
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>
    </div>
  );
}

export function CarbonEvidenceSection({ groupId }: { groupId: string }) {
  const { t } = useT();
  const plots = useApiQuery(`vsla-carbon:ev-plots:${groupId}`, () =>
    fetchCarbonPlots(groupId).then((res) => res.data)
  );
  const [plotId, setPlotId] = useState('');
  const evidence = useApiQuery(plotId ? `vsla-carbon:evidence:${plotId}` : null, () =>
    fetchCarbonEvidence(plotId).then((res) => res.data)
  );
  const estimates = useApiQuery(plotId ? `vsla-carbon:estimates:${plotId}` : null, () =>
    fetchCarbonEstimates(plotId).then((res) => res.data)
  );
  const [season, setSeason] = useState('');
  const [survival, setSurvival] = useState('');
  const [linkNdvi, setLinkNdvi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useApiMutation<
    { season: string; survivalRatePct?: number; linkNdvi: boolean },
    unknown
  >({
    mutationFn: async (input) =>
      submitCarbonEvidence(plotId, { ...input, idempotencyKey: newKey('web-evidence') }),
    onSuccess: () => {
      setNotice(t('vslaCarbon.evidenceRecordedNotice'));
      evidence.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  const estimate = useApiMutation<string, unknown>({
    mutationFn: async (estimateSeason) => estimateCarbonPlot(plotId, estimateSeason),
    onSuccess: () => {
      setNotice(t('vslaCarbon.estimateRecordedNotice'));
      estimates.refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  return (
    <div>
      <Field label={t('vslaCarbon.plotLabel')} id="evidence-plot">
        <Select
          id="evidence-plot"
          value={plotId}
          onChange={(event) => setPlotId(event.target.value)}
        >
          <option value="">{t('vslaCarbon.plotPlaceholder')}</option>
          {(plots.data ?? []).map((plot) => (
            <option key={plot.id} value={plot.id}>
              {plot.name}
            </option>
          ))}
        </Select>
      </Field>
      {plotId ? (
        <div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setNotice(null);
              const survivalPct = survival.trim() === '' ? undefined : Number(survival);
              if (
                !/^\d{4}(-(wet|dry))?$/.test(season) ||
                (survivalPct !== undefined &&
                  (!Number.isInteger(survivalPct) || survivalPct < 0 || survivalPct > 100))
              ) {
                setError(t('vslaCarbon.evidenceInvalid'));
                return;
              }
              void submit.mutate({ season, survivalRatePct: survivalPct, linkNdvi });
            }}
          >
            <Field label={t('vslaCarbon.seasonLabel')} id="evidence-season">
              <TextInput
                id="evidence-season"
                placeholder="2026-wet"
                value={season}
                onChange={(event) => setSeason(event.target.value)}
              />
            </Field>
            <Field label={t('vslaCarbon.survivalLabel')} id="evidence-survival">
              <TextInput
                id="evidence-survival"
                inputMode="numeric"
                value={survival}
                onChange={(event) => setSurvival(event.target.value)}
              />
            </Field>
            <Field label={t('vslaCarbon.ndviLinkLabel')} id="evidence-ndvi">
              <Select
                id="evidence-ndvi"
                value={linkNdvi ? 'yes' : 'no'}
                onChange={(event) => setLinkNdvi(event.target.value === 'yes')}
              >
                <option value="no">{t('vslaCarbon.ndviLinkNo')}</option>
                <option value="yes">{t('vslaCarbon.ndviLinkYes')}</option>
              </Select>
            </Field>
            <button type="submit" disabled={submit.status === 'pending'}>
              {submit.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.submitEvidenceAction')}
            </button>
            <button
              type="button"
              disabled={estimate.status === 'pending' || !/^\d{4}(-(wet|dry))?$/.test(season)}
              onClick={() => {
                setError(null);
                void estimate.mutate(season);
              }}
            >
              {estimate.status === 'pending' ? t('vslaCarbon.working') : t('vslaCarbon.estimateAction')}
            </button>
          </form>
          <QueryState
            isLoading={evidence.isLoading}
            error={evidence.error}
            data={evidence.data}
            onRetry={evidence.refresh}
            empty={<EmptyState title={t('vslaCarbon.evidenceEmpty')} />}
          >
            {evidence.data && evidence.data.length > 0 ? (
              <ul>
                {evidence.data.map((row) => (
                  <li key={row.id} data-testid={`evidence-${row.id}`}>
                    {row.season} · {row.submitterRole}
                    {row.survivalRatePct !== undefined
                      ? ` · ${t('vslaCarbon.survivalLabel')} ${row.survivalRatePct}%`
                      : ''}
                    {row.ndviBasis ? (
                      <>
                        {' '}
                        · NDVI {row.ndviHealthScore} <BasisBadge basis={row.ndviBasis} />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </QueryState>
          <QueryState
            isLoading={estimates.isLoading}
            error={estimates.error}
            data={estimates.data}
            onRetry={estimates.refresh}
          >
            {estimates.data && estimates.data.length > 0 ? (
              <ul>
                {estimates.data.map((row) => (
                  <li key={row.id} data-testid={`estimate-${row.id}`}>
                    {row.season} · {(row.co2eMilliTonnes / 1000).toFixed(3)} t CO2e{' '}
                    <BasisBadge basis="estimate" />
                    <span className="small muted"> · {row.coefficientVersion}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </QueryState>
        </div>
      ) : null}
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
    </div>
  );
}

/* ------------------------------ MRV reporting ----------------------------- */

/** CSV export of the programme MRV report (authenticated file download). */
export function MrvCsvDownload() {
  const { t } = useT();
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'working' }
    | { status: 'done'; fileName: string }
    | { status: 'failed'; message: string }
  >({ status: 'idle' });

  async function run() {
    setState({ status: 'working' });
    try {
      const fileName = await downloadVslaCarbonMrvExport();
      setState({ status: 'done', fileName });
    } catch (error) {
      setState({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return (
    <p className="small">
      <button
        type="button"
        data-testid="mrv-csv-download"
        disabled={state.status === 'working'}
        onClick={() => void run()}
      >
        {state.status === 'working' ? t('vslaCarbon.working') : t('vslaCarbon.exportCsvAction')}
      </button>
      {state.status === 'done' ? (
        <StatusBadge tone="success">downloaded {state.fileName}</StatusBadge>
      ) : null}
      {state.status === 'failed' ? (
        <span role="alert" className="notice">
          {state.message}
        </span>
      ) : null}
    </p>
  );
}

export function MrvReportSection({ groupId }: { groupId: string | null }) {
  const { t } = useT();
  const groupReport = useApiQuery(groupId ? `vsla-carbon:mrv-group:${groupId}` : null, () =>
    fetchGroupMrvReport(groupId as string).then((res) => res.data)
  );
  const programme = useApiQuery('vsla-carbon:mrv-programme', () =>
    fetchProgrammeMrvReport().then((res) => res.data)
  );

  return (
    <div>
      <p className="small muted" data-testid="mrv-disclaimer">
        {t('vslaCarbon.reportDisclaimer')}
      </p>
      {groupId ? (
        <QueryState
          isLoading={groupReport.isLoading}
          error={groupReport.error}
          data={groupReport.data}
          onRetry={groupReport.refresh}
        >
          {groupReport.data ? (
            <Card title={t('vslaCarbon.groupReportTitle')}>
              <p data-testid="group-mrv-summary">
                {groupReport.data.hectaresUnderPractice.toFixed(2)} ha ·{' '}
                {t('vslaCarbon.survivalLabel')}{' '}
                {groupReport.data.meanSurvivalRatePct ?? '—'}% ·{' '}
                {groupReport.data.estimatedCo2eTonnes.toFixed(3)} t CO2e{' '}
                {groupReport.data.basisFlags.map((flag) => (
                  <BasisBadge key={flag} basis={flag} />
                ))}
              </p>
              <p className="small muted">{groupReport.data.disclaimer}</p>
            </Card>
          ) : null}
        </QueryState>
      ) : null}
      <QueryState
        isLoading={programme.isLoading}
        error={programme.error}
        data={programme.data}
        onRetry={programme.refresh}
      >
        {programme.data ? (
          <Card title={t('vslaCarbon.programmeReportTitle')}>
            <p data-testid="programme-mrv-summary">
              {programme.data.groupCount} {t('vslaCarbon.groupsWord')} ·{' '}
              {programme.data.hectaresUnderPractice.toFixed(2)} ha ·{' '}
              {programme.data.estimatedCo2eTonnes.toFixed(3)} t CO2e{' '}
              {programme.data.basisFlags.map((flag) => (
                <BasisBadge key={flag} basis={flag} />
              ))}
            </p>
            <p className="small">
              {t('vslaCarbon.evidenceWord')}: {programme.data.evidenceCount} ·{' '}
              {t('vslaCarbon.ndviLinkedWord')}: {programme.data.ndviLinkedEvidenceCount}
            </p>
            <p className="small muted">{programme.data.disclaimer}</p>
            <MrvCsvDownload />
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
}

/* ------------------------------- composition ------------------------------ */

export function VslaCarbonDashboard() {
  const [selectedGroupId, setSelectedGroupId] = useSelectedGroup();
  const { t } = useT();
  return (
    <div>
      <VslaGroupsSection selectedGroupId={selectedGroupId} onSelect={setSelectedGroupId} />
      {selectedGroupId ? (
        <div data-testid="selected-group-panels">
          <h3>{t('vslaCarbon.cyclesTitle')}</h3>
          <VslaCycleSection groupId={selectedGroupId} />
          <h3>{t('vslaCarbon.loansTitle')}</h3>
          <VslaLoansSection groupId={selectedGroupId} />
          <h3>{t('vslaCarbon.plotsTitle')}</h3>
          <CarbonPlotsSection groupId={selectedGroupId} />
          <h3>{t('vslaCarbon.evidenceTitle')}</h3>
          <CarbonEvidenceSection groupId={selectedGroupId} />
        </div>
      ) : (
        <EmptyState title={t('vslaCarbon.selectGroupPrompt')} />
      )}
    </div>
  );
}
