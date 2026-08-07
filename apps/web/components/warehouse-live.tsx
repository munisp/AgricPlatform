'use client';

import Link from 'next/link';
import { useState } from 'react';
import { WAREHOUSE_CERTIFICATION_STATUSES } from '@agric-platform/shared';
import type {
  CertifiedWarehouse,
  WarehouseCertificationStatus,
  WarehouseReceipt,
  WarehouseReceiptStatus
} from '@agric-platform/shared';
import { useT } from '@/lib/i18n';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  createWarehouseDeposit,
  fetchWarehouseIntegrationStatus,
  fetchWarehouseReceipt,
  fetchWarehouseRegistryExport,
  listMyWarehouseDeposits,
  listMyWarehousePledges,
  listMyWarehouseReceipts,
  listReceiptPledges,
  listReceiptTransfers,
  listWarehouses,
  pledgeWarehouseReceipt,
  redeemWarehouseReceipt,
  releaseWarehousePledge,
  transferWarehouseReceipt,
  verifyWarehouseReceipt
} from '@/lib/api/endpoints';
import { Field, Select, TextInput } from '@/components/forms';
import { QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, formatKobo, StatusBadge, Timeline } from '@/components/ui';

/** Canonical receipt pipeline for the status timeline. */
const RECEIPT_FLOW: WarehouseReceiptStatus[] = ['active', 'pledged', 'released', 'redeemed'];

export function receiptTimeline(receipt: WarehouseReceipt) {
  const currentIndex = RECEIPT_FLOW.indexOf(receipt.status);
  return RECEIPT_FLOW.slice(0, Math.max(currentIndex + 1, 1)).map((status, index) => ({
    id: status,
    title: status,
    tone: (index === currentIndex ? 'warning' : 'default') as 'warning' | 'default'
  }));
}

/* --------------------------- integration badges ------------------------- */

export function WarehouseIntegrationBadges() {
  const { t } = useT();
  const query = useApiQuery(
    'warehouse-integrations',
    () => fetchWarehouseIntegrationStatus().then((res) => res.data)
  );
  const status = query.data;
  return (
    <div className="cluster" data-testid="warehouse-integration-badges">
      <span className="small muted">{t('warehouse.certificationDriverLabel')}</span>
      <StatusBadge tone={status?.certificationDriver === 'live' ? 'success' : 'warning'}>
        {status?.certificationDriver === 'live' ? t('warehouse.basisLive') : t('warehouse.basisStub')}
      </StatusBadge>
      <span className="small muted">{t('warehouse.registryDriverLabel')}</span>
      <StatusBadge tone={status?.collateralRegistryDriver === 'live' ? 'success' : 'warning'}>
        {status?.collateralRegistryDriver === 'live'
          ? t('warehouse.basisLive')
          : t('warehouse.basisStub')}
      </StatusBadge>
    </div>
  );
}

/* ------------------------------ browse ---------------------------------- */

export function WarehouseBrowser() {
  const { t } = useT();
  const [state, setState] = useState('');
  const [certification, setCertification] = useState<'' | WarehouseCertificationStatus>('certified');

  const query = useApiQuery(
    `warehouse-list:${state}:${certification}`,
    () =>
      listWarehouses({
        state: state || undefined,
        certificationStatus: certification || undefined
      }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">{t('warehouse.browseTitle')}</legend>
        <Field id="wh-state" label={t('warehouse.filterState')}>
          <TextInput id="wh-state" value={state} onChange={(e) => setState(e.target.value)} />
        </Field>
        <Field id="wh-cert" label={t('warehouse.certificationLabel')}>
          <Select
            id="wh-cert"
            value={certification}
            onChange={(e) => setCertification(e.target.value as '' | WarehouseCertificationStatus)}
          >
            <option value="">{t('warehouse.filterAllStates')}</option>
            {WAREHOUSE_CERTIFICATION_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title={t('warehouse.browseEmpty')} />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((warehouse) => (
            <Card key={warehouse.id} title={warehouse.name}>
              <p className="small muted">
                {warehouse.lga}, {warehouse.state}
              </p>
              <p className="small">
                {t('warehouse.capacityLabel')}: {t('warehouse.capacityTonnes', { tonnes: warehouse.capacityTonnes })}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <AutoBadge value={warehouse.certificationStatus} />
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* ---------------------------- deposit form ------------------------------ */

export function DepositForm() {
  const { t } = useT();
  const [warehouseId, setWarehouseId] = useState('');
  const [crop, setCrop] = useState('');
  const [lotId, setLotId] = useState('');
  const [done, setDone] = useState(false);

  const warehouses = useApiQuery(
    'warehouse-list:certified',
    () => listWarehouses({ certificationStatus: 'certified' }).then((res) => res.data),
    { fallbackData: [] }
  );

  const mutation = useApiMutation<
    { warehouseId: string; crop: string; lotId?: string },
    { id: string }
  >({
    mutationFn: (input) => createWarehouseDeposit(input).then((res) => res.data),
    onSuccess: () => setDone(true)
  });

  const valid = warehouseId !== '' && crop.trim() !== '';

  return (
    <Card title={t('warehouse.depositTitle')}>
      {done ? <p role="status">{t('warehouse.depositSuccess')}</p> : null}
      <div className="form-grid cols-2">
        <Field id="dep-warehouse" label={t('warehouse.depositWarehouse')}>
          <Select
            id="dep-warehouse"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            <option value="">—</option>
            {(warehouses.data ?? []).map((warehouse: CertifiedWarehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name} ({warehouse.lga})
              </option>
            ))}
          </Select>
        </Field>
        <Field id="dep-crop" label={t('warehouse.depositCrop')}>
          <TextInput id="dep-crop" value={crop} onChange={(e) => setCrop(e.target.value)} />
        </Field>
        <Field id="dep-lot" label={t('warehouse.depositLot')}>
          <TextInput id="dep-lot" value={lotId} onChange={(e) => setLotId(e.target.value)} />
        </Field>
      </div>
      {mutation.error ? <p role="alert" className="small">{String(mutation.error)}</p> : null}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!valid || mutation.status === 'pending'}
        onClick={() =>
          mutation.mutate({
            warehouseId,
            crop: crop.trim(),
            ...(lotId.trim() ? { lotId: lotId.trim() } : {})
          })
        }
      >
        {mutation.status === 'pending' ? t('warehouse.depositWorking') : t('warehouse.depositAction')}
      </button>
    </Card>
  );
}

/* ----------------------------- my deposits ------------------------------ */

export function MyDeposits() {
  const { t } = useT();
  const query = useApiQuery(
    'warehouse-deposits:mine',
    () => listMyWarehouseDeposits().then((res) => res.data),
    { fallbackData: [] }
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title={t('warehouse.depositsEmpty')} />}
    >
      <div className="grid grid-2">
        {(query.data ?? []).map((deposit) => (
          <Card key={deposit.id} title={deposit.crop}>
            <AutoBadge value={deposit.status} />
            {deposit.grading ? (
              <p className="small">
                {t('warehouse.gradeLabel')} {deposit.grading.grade} ·{' '}
                {t('warehouse.weightKg', { kg: deposit.grading.weightKg })}
              </p>
            ) : (
              <p className="small muted">{t('warehouse.gradingPending')}</p>
            )}
            {deposit.receiptId ? (
              <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
                <Link
                  className="btn btn-ghost btn-small"
                  href={`/warehouse/receipts/${deposit.receiptId}`}
                >
                  {t('warehouse.receiptDetail')}
                </Link>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </QueryState>
  );
}

/* ----------------------------- my receipts ------------------------------ */

export function MyReceipts() {
  const { t } = useT();
  const query = useApiQuery(
    'warehouse-receipts:mine',
    () => listMyWarehouseReceipts().then((res) => res.data),
    { fallbackData: [] }
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title={t('warehouse.receiptsEmpty')} />}
    >
      <div className="grid grid-2">
        {(query.data ?? []).map((receipt) => (
          <Card key={receipt.id} title={receipt.receiptNumber}>
            <AutoBadge value={receipt.status} />
            <p className="small">
              {receipt.crop} · {t('warehouse.gradeLabel')} {receipt.grade} ·{' '}
              {t('warehouse.weightKg', { kg: receipt.weightKg })}
            </p>
            <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
              <Link className="btn btn-ghost btn-small" href={`/warehouse/receipts/${receipt.id}`}>
                {t('warehouse.receiptDetail')}
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </QueryState>
  );
}

/* ---------------------------- receipt detail ---------------------------- */

export function ReceiptDetail({ receiptId }: { receiptId: string }) {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [toOwnerId, setToOwnerId] = useState('');
  const [note, setNote] = useState('');
  const [principal, setPrincipal] = useState('');
  const [terms, setTerms] = useState('');
  const [validity, setValidity] = useState<boolean | undefined>(undefined);

  const query = useApiQuery(`warehouse-receipt:${receiptId}`, () =>
    fetchWarehouseReceipt(receiptId).then((res) => res.data)
  );
  const pledges = useApiQuery(
    `warehouse-receipt-pledges:${receiptId}`,
    () => listReceiptPledges(receiptId).then((res) => res.data),
    { fallbackData: [] }
  );
  const transfers = useApiQuery(
    `warehouse-receipt-transfers:${receiptId}`,
    () => listReceiptTransfers(receiptId).then((res) => res.data),
    { fallbackData: [] }
  );

  const refreshAll = () => {
    query.refresh();
    pledges.refresh();
    transfers.refresh();
  };

  const run = (fn: () => Promise<unknown>) => {
    setPending(true);
    return fn()
      .then(refreshAll)
      .finally(() => setPending(false));
  };

  const receipt = query.data;
  const transferable = receipt?.status === 'active' || receipt?.status === 'released';

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={receipt}
      onRetry={query.refresh}
      empty={<EmptyState title={t('warehouse.receiptsEmpty')} />}
    >
      {receipt ? (
        <div className="stack">
          <Card title={receipt.receiptNumber}>
            <Timeline items={receiptTimeline(receipt)} />
            <dl className="small">
              <dt>{t('warehouse.depositCrop')}</dt>
              <dd>{receipt.crop}</dd>
              <dt>{t('warehouse.gradeLabel')}</dt>
              <dd>{receipt.grade}</dd>
              <dt>{t('warehouse.bagsLabel')}</dt>
              <dd>{receipt.bagCount}</dd>
              <dt>{t('warehouse.weightLabel')}</dt>
              <dd>{t('warehouse.weightKg', { kg: receipt.weightKg })}</dd>
              <dt>{t('warehouse.issuedLabel')}</dt>
              <dd>{receipt.issuedAt.slice(0, 10)}</dd>
            </dl>
            <div className="cluster">
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    verifyWarehouseReceipt(receiptId).then((res) => setValidity(res.data.valid))
                  )
                }
              >
                {t('warehouse.verifyAction')}
              </button>
              {validity !== undefined ? (
                <StatusBadge tone={validity ? 'success' : 'critical'}>
                  {validity ? t('warehouse.signatureValid') : t('warehouse.signatureInvalid')}
                </StatusBadge>
              ) : null}
            </div>
          </Card>

          <div className="cluster">
            {transferable ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => void run(() => redeemWarehouseReceipt(receiptId))}
              >
                {t('warehouse.redeemAction')}
              </button>
            ) : null}
          </div>

          {transferable ? (
            <Card title={t('warehouse.transferTitle')}>
              <div className="form-grid cols-2">
                <Field id="whr-to" label={t('warehouse.transferToLabel')}>
                  <TextInput
                    id="whr-to"
                    value={toOwnerId}
                    onChange={(e) => setToOwnerId(e.target.value)}
                  />
                </Field>
                <Field id="whr-note" label={t('warehouse.transferNoteLabel')}>
                  <TextInput id="whr-note" value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={toOwnerId.trim() === '' || pending}
                onClick={() =>
                  void run(() =>
                    transferWarehouseReceipt(receiptId, {
                      toOwnerId: toOwnerId.trim(),
                      ...(note.trim() ? { note: note.trim() } : {})
                    })
                  )
                }
              >
                {pending ? t('warehouse.transferWorking') : t('warehouse.transferAction')}
              </button>
            </Card>
          ) : null}

          {receipt.status === 'active' || receipt.status === 'released' ? (
            <Card title={t('warehouse.pledgeTitle')}>
              <div className="form-grid cols-2">
                <Field id="whr-principal" label={t('warehouse.pledgePrincipalLabel')}>
                  <TextInput
                    id="whr-principal"
                    inputMode="decimal"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                  />
                </Field>
                <Field id="whr-terms" label={t('warehouse.pledgeTermsLabel')}>
                  <TextInput id="whr-terms" value={terms} onChange={(e) => setTerms(e.target.value)} />
                </Field>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Number(principal) <= 0 || pending}
                onClick={() =>
                  void run(() =>
                    pledgeWarehouseReceipt(receiptId, {
                      principalKobo: Math.round(Number(principal) * 100),
                      ...(terms.trim() ? { terms: terms.trim() } : {})
                    })
                  )
                }
              >
                {pending ? t('warehouse.pledgeWorking') : t('warehouse.pledgeAction')}
              </button>
            </Card>
          ) : null}

          <h3>{t('warehouse.pledgesTitle')}</h3>
          <QueryState
            isLoading={pledges.isLoading}
            error={pledges.source === 'fallback' ? undefined : pledges.error}
            data={pledges.data}
            onRetry={pledges.refresh}
            empty={<EmptyState title={t('warehouse.pledgesEmpty')} />}
          >
            <div className="grid grid-2">
              {(pledges.data ?? []).map((pledge) => (
                <Card key={pledge.id} title={formatKobo(pledge.principalKobo)}>
                  <div className="cluster">
                    <AutoBadge value={pledge.status} />
                    <StatusBadge tone={pledge.registryBasis === 'live' ? 'success' : 'warning'}>
                      {pledge.registryBasis === 'live'
                        ? t('warehouse.basisLive')
                        : t('warehouse.basisStub')}
                    </StatusBadge>
                  </div>
                  {pledge.registryRef ? <p className="small muted">{pledge.registryRef}</p> : null}
                  {pledge.status === 'active' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={pending}
                      onClick={() => void run(() => releaseWarehousePledge(receiptId))}
                    >
                      {t('warehouse.releaseAction')}
                    </button>
                  ) : null}
                </Card>
              ))}
            </div>
          </QueryState>

          <h3>{t('warehouse.transfersTitle')}</h3>
          <QueryState
            isLoading={transfers.isLoading}
            error={transfers.source === 'fallback' ? undefined : transfers.error}
            data={transfers.data}
            onRetry={transfers.refresh}
            empty={<EmptyState title={t('warehouse.transfersEmpty')} />}
          >
            <ul className="small">
              {(transfers.data ?? []).map((transfer) => (
                <li key={transfer.id}>
                  {t('warehouse.transferFromTo', {
                    from: transfer.fromOwnerId,
                    to: transfer.toOwnerId
                  })}{' '}
                  · {transfer.createdAt.slice(0, 10)}
                  {transfer.note ? ` — ${transfer.note}` : ''}
                </li>
              ))}
            </ul>
          </QueryState>
        </div>
      ) : null}
    </QueryState>
  );
}

/* ----------------------------- lender desk ------------------------------ */

export function LenderPledgeBook() {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const query = useApiQuery(
    'warehouse-pledges:mine',
    () => listMyWarehousePledges().then((res) => res.data),
    { fallbackData: [] }
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title={t('warehouse.lenderBookEmpty')} />}
    >
      <div className="grid grid-2">
        {(query.data ?? []).map((pledge) => (
          <Card key={pledge.id} title={formatKobo(pledge.principalKobo)}>
            <div className="cluster">
              <AutoBadge value={pledge.status} />
              <StatusBadge tone={pledge.registryBasis === 'live' ? 'success' : 'warning'}>
                {pledge.registryBasis === 'live' ? t('warehouse.basisLive') : t('warehouse.basisStub')}
              </StatusBadge>
            </div>
            <p className="small muted">{pledge.receiptId}</p>
            <div className="cluster" style={{ marginTop: '0.6rem' }}>
              {pledge.status === 'active' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={pending}
                  onClick={() => {
                    setPending(true);
                    void releaseWarehousePledge(pledge.receiptId)
                      .then(() => query.refresh())
                      .finally(() => setPending(false));
                  }}
                >
                  {t('warehouse.releaseAction')}
                </button>
              ) : null}
              <Link
                className="btn btn-ghost btn-small"
                href={`/warehouse/receipts/${pledge.receiptId}`}
              >
                {t('warehouse.receiptDetail')}
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </QueryState>
  );
}

/* --------------------------- regulator export --------------------------- */

export function RegistryExportSection() {
  const { t } = useT();
  const query = useApiQuery('warehouse-registry-export', () =>
    fetchWarehouseRegistryExport().then((res) => res.data)
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title={t('warehouse.exportEmpty')} />}
    >
      {query.data ? (
        <Card title={t('warehouse.exportTitle')}>
          <p data-testid="warehouse-export-counts">
            {t('warehouse.exportCounts', {
              receipts: query.data.receipts.length,
              pledges: query.data.pledges.length,
              transfers: query.data.transfers.length
            })}
          </p>
          <p className="small muted">{query.data.exportedAt}</p>
        </Card>
      ) : null}
    </QueryState>
  );
}
