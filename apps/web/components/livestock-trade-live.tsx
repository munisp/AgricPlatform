'use client';

import { useState } from 'react';
import {
  EXPORT_DOCUMENT_TYPES,
  EXPORT_DOCUMENT_WATERMARK,
  LIVESTOCK_SUBJECT_TYPES,
  NIGERIAN_STATES,
  OFFTAKE_CONTRACT_STATUSES
} from '@agric-platform/shared';
import type {
  CertifiedListing,
  ExportDocument,
  ExportDocumentType,
  LivestockSubjectType,
  OfftakeContract,
  OfftakeContractStatus,
  OfftakeTemplate
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  activateCertifiedListing,
  createCertifiedListing,
  generateExportDocument,
  instantiateOfftakeContract,
  listExportDocuments,
  listMyCertifiedListings,
  listMyOfftakeContracts,
  listOfftakeTemplates,
  markCertifiedListingSold,
  transitionOfftakeContract,
  withdrawCertifiedListing
} from '@/lib/api/endpoints';
import {
  demoCertifiedListings,
  demoExportDocuments,
  demoOfftakeContracts,
  demoOfftakeTemplates
} from '@/lib/content';
import { Field, Select, TextInput } from '@/components/forms';
import { AutoBadge, Card, StatusBadge, formatKobo } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/livestock-trade/*.
const FALLBACK_LISTINGS = demoCertifiedListings;
const FALLBACK_TEMPLATES = demoOfftakeTemplates;
const FALLBACK_CONTRACTS = demoOfftakeContracts;
const FALLBACK_EXPORT_DOCS = demoExportDocuments;

function dateLabel(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'medium' });
}

/** Naira text input → integer kobo (money math stays in kobo). */
function nairaToKobo(value: string): number | undefined {
  const naira = Number(value);
  if (!Number.isFinite(naira) || value.trim() === '') return undefined;
  return Math.round(naira * 100);
}

/* ---------------------------- certified listings ------------------------ */

export function CertifiedListingsPanel() {
  const { userId, hydrated } = useAppState();
  const [subjectType, setSubjectType] = useState<LivestockSubjectType>('animal');
  const [subjectId, setSubjectId] = useState('');
  const [price, setPrice] = useState('');

  const query = useApiQuery(
    hydrated ? 'livestock-trade:listings:mine' : null,
    () => listMyCertifiedListings().then((res) => res.data),
    { fallbackData: FALLBACK_LISTINGS, enabled: hydrated }
  );

  const create = useApiMutation<void, CertifiedListing>({
    mutationFn: () =>
      createCertifiedListing({
        subjectType,
        subjectId: subjectId.trim(),
        askingPriceKobo: nairaToKobo(price)
      }).then((res) => res.data),
    queue: {
      kind: 'livestock-trade.listing.created',
      label: () => `Certify ${subjectId.trim()}`,
      method: 'POST',
      path: () => '/livestock-trade/listings',
      payload: () => ({ subjectType, subjectId: subjectId.trim(), askingPriceKobo: nairaToKobo(price) })
    },
    onSuccess: () => {
      setSubjectId('');
      setPrice('');
      query.refresh();
    }
  });

  const lifecycle = useApiMutation<{ id: string; action: 'activate' | 'sold' | 'withdraw' }, CertifiedListing>({
    mutationFn: ({ id, action }) => {
      if (action === 'activate') return activateCertifiedListing(id).then((res) => res.data);
      if (action === 'sold') return markCertifiedListingSold(id).then((res) => res.data);
      return withdrawCertifiedListing(id).then((res) => res.data);
    },
    onSuccess: () => query.refresh()
  });

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <Card title="Certify an animal or lot">
        <p className="small muted">
          Certification captures a provenance snapshot (ownership depth + consent) and requires
          livestock enrolment. Only the registry owner can certify.
        </p>
        <div className="form-grid cols-2">
          <Field id="cl-type" label="Subject type">
            <Select
              id="cl-type"
              value={subjectType}
              onChange={(event) => setSubjectType(event.target.value as LivestockSubjectType)}
            >
              {LIVESTOCK_SUBJECT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="cl-subject" label="Subject ID">
            <TextInput
              id="cl-subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              placeholder={subjectType === 'animal' ? 'NG-BOV-KD-000123' : 'LOT-AVI-KD-000007'}
            />
          </Field>
          <Field id="cl-price" label="Asking price (₦, optional)">
            <TextInput
              id="cl-price"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="e.g. 450000"
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          {create.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={subjectId.trim().length < 4 || create.status === 'pending'}
            onClick={() => void create.mutate()}
          >
            {create.status === 'pending' ? 'Certifying…' : 'Create certified listing'}
          </button>
        </div>
        {create.status === 'error' ? <ApiErrorNotice error={create.error} /> : null}
      </Card>

      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<p className="small muted">No certified listings yet — certify an animal above.</p>}
      >
        <div className="grid grid-2">
          {(query.data ?? []).map((listing) => (
            <Card key={listing.id} title={`${listing.species}${listing.breed ? ` · ${listing.breed}` : ''}`}>
              <article id={`certified-${listing.id}`}>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">{listing.subjectId}</span>
                  <AutoBadge value={listing.status} ariaLabel={`Certification status: ${listing.status}`} />
                </div>
                <dl className="detail-list" style={{ marginTop: '0.5rem' }}>
                  <div className="cluster" style={{ justifyContent: 'space-between' }}>
                    <dt className="small muted">Listing ID</dt>
                    <dd className="small">{listing.id}</dd>
                  </div>
                  <div className="cluster" style={{ justifyContent: 'space-between' }}>
                    <dt className="small muted">Ownership depth</dt>
                    <dd className="small">
                      {listing.provenance.ownershipDepth} transfer
                      {listing.provenance.ownershipDepth === 1 ? '' : 's'}
                    </dd>
                  </div>
                  <div className="cluster" style={{ justifyContent: 'space-between' }}>
                    <dt className="small muted">Consent at certification</dt>
                    <dd className="small">{listing.provenance.consentGranted ? 'granted' : 'missing'}</dd>
                  </div>
                  {listing.quantity ? (
                    <div className="cluster" style={{ justifyContent: 'space-between' }}>
                      <dt className="small muted">Lot size</dt>
                      <dd className="small">{listing.quantity}</dd>
                    </div>
                  ) : null}
                  {listing.askingPriceKobo !== undefined ? (
                    <div className="cluster" style={{ justifyContent: 'space-between' }}>
                      <dt className="small muted">Asking price</dt>
                      <dd className="small">{formatKobo(listing.askingPriceKobo)}</dd>
                    </div>
                  ) : null}
                </dl>
                {listing.sellerUserId === userId &&
                (listing.status === 'draft' || listing.status === 'active') ? (
                  <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                    {listing.status === 'draft' ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        disabled={lifecycle.status === 'pending'}
                        onClick={() => void lifecycle.mutate({ id: listing.id, action: 'activate' })}
                      >
                        Activate
                      </button>
                    ) : null}
                    {listing.status === 'active' ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={lifecycle.status === 'pending'}
                        onClick={() => void lifecycle.mutate({ id: listing.id, action: 'sold' })}
                      >
                        Mark sold
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={lifecycle.status === 'pending'}
                      onClick={() => void lifecycle.mutate({ id: listing.id, action: 'withdraw' })}
                    >
                      Withdraw
                    </button>
                  </div>
                ) : null}
                {listing.status === 'revoked' && listing.revocationReason ? (
                  <p className="small muted">Revoked: {listing.revocationReason}</p>
                ) : null}
              </article>
            </Card>
          ))}
        </div>
      </QueryState>
      {lifecycle.status === 'error' ? <ApiErrorNotice error={lifecycle.error} /> : null}
    </>
  );
}

/* ----------------------------- offtake contracts ------------------------ */

export function OfftakePanel() {
  const { userId, hydrated } = useAppState();
  const [templateId, setTemplateId] = useState('');
  const [buyerUserId, setBuyerUserId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [pricePerUnit, setPricePerUnit] = useState('');

  const templates = useApiQuery(
    hydrated ? 'livestock-trade:offtake-templates' : null,
    () => listOfftakeTemplates({ status: 'active' }).then((res) => res.data),
    { fallbackData: FALLBACK_TEMPLATES, enabled: hydrated }
  );

  const contracts = useApiQuery(
    hydrated ? 'livestock-trade:offtake-contracts:mine' : null,
    () => listMyOfftakeContracts().then((res) => res.data),
    { fallbackData: FALLBACK_CONTRACTS, enabled: hydrated }
  );

  const template = (templates.data ?? []).find((item) => item.id === templateId);

  const instantiate = useApiMutation<void, OfftakeContract>({
    mutationFn: () =>
      instantiateOfftakeContract(templateId, {
        farmerUserId: userId,
        buyerUserId: buyerUserId.trim(),
        quantity: quantity ? Number(quantity) : undefined,
        pricePerUnitKobo: nairaToKobo(pricePerUnit)
      }).then((res) => res.data),
    onSuccess: () => {
      setBuyerUserId('');
      setQuantity('');
      setPricePerUnit('');
      contracts.refresh();
    }
  });

  const transition = useApiMutation<{ id: string; to: OfftakeContractStatus }, OfftakeContract>({
    mutationFn: ({ id, to }) => transitionOfftakeContract(id, to).then((res) => res.data),
    onSuccess: () => contracts.refresh()
  });

  const quantityNumber = quantity ? Number(quantity) : undefined;
  const instantiateValid =
    templateId.length > 0 &&
    buyerUserId.trim().length >= 3 &&
    (quantityNumber === undefined || (Number.isInteger(quantityNumber) && quantityNumber >= 1));

  return (
    <div className="grid grid-2">
      <Card title="Instantiate from a template">
        {templates.source === 'fallback' ? <OfflineDataNotice /> : null}
        <Field id="ot-template" label="Template">
          <Select
            id="ot-template"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">Select template…</option>
            {(templates.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.species})
              </option>
            ))}
          </Select>
        </Field>
        {template ? (
          <p className="small muted">
            {template.description ?? 'No description'} · window {template.deliveryWindowDays} days
            {template.defaultQuantity ? ` · default qty ${template.defaultQuantity}` : ''}
            {template.defaultPricePerUnitKobo !== undefined
              ? ` · default ${formatKobo(template.defaultPricePerUnitKobo)}/unit`
              : ''}
            {template.defaultQualityGrade ? ` · grade ${template.defaultQualityGrade}` : ''}
          </p>
        ) : null}
        <div className="form-grid cols-2">
          <Field id="ot-buyer" label="Buyer (user ID)">
            <TextInput
              id="ot-buyer"
              value={buyerUserId}
              onChange={(event) => setBuyerUserId(event.target.value)}
              placeholder="e.g. user-buyer"
            />
          </Field>
          <Field id="ot-quantity" label={`Quantity (default ${template?.defaultQuantity ?? '—'})`}>
            <TextInput
              id="ot-quantity"
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>
          <Field
            id="ot-price"
            label={`Price per unit (₦, default ${
              template?.defaultPricePerUnitKobo !== undefined
                ? formatKobo(template.defaultPricePerUnitKobo)
                : '—'
            })`}
          >
            <TextInput
              id="ot-price"
              inputMode="decimal"
              value={pricePerUnit}
              onChange={(event) => setPricePerUnit(event.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!instantiateValid || instantiate.status === 'pending'}
            onClick={() => void instantiate.mutate()}
          >
            {instantiate.status === 'pending' ? 'Creating…' : 'Create contract'}
          </button>
        </div>
        {instantiate.status === 'error' ? <ApiErrorNotice error={instantiate.error} /> : null}
      </Card>

      <Card title="My contracts">
        {contracts.source === 'fallback' ? <OfflineDataNotice /> : null}
        <QueryState
          isLoading={contracts.isLoading}
          error={contracts.source === 'fallback' ? undefined : contracts.error}
          data={contracts.data}
          onRetry={contracts.refresh}
          empty={<p className="small muted">No offtake contracts yet.</p>}
        >
          <ul className="row-list">
            {(contracts.data ?? []).map((contract) => (
              <li className="row-item" key={contract.id}>
                <div className="row-main small">
                  <strong>{contract.id}</strong> · {contract.quantity} {contract.species} ·{' '}
                  {formatKobo(contract.totalKobo)} · deliver {dateLabel(contract.deliveryWindowStart)} –{' '}
                  {dateLabel(contract.deliveryWindowEnd)}
                  {contract.qualityGrade ? ` · grade ${contract.qualityGrade}` : ''}
                </div>
                <span className="cluster">
                  <AutoBadge value={contract.status} />
                  <Field id={`ot-transition-${contract.id}`} label={`Transition ${contract.id}`}>
                    <Select
                      id={`ot-transition-${contract.id}`}
                      value=""
                      disabled={transition.status === 'pending'}
                      onChange={(event) => {
                        const to = event.target.value as OfftakeContractStatus | '';
                        if (to) void transition.mutate({ id: contract.id, to });
                      }}
                    >
                      <option value="">Set status…</option>
                      {OFFTAKE_CONTRACT_STATUSES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
        {transition.status === 'error' ? <ApiErrorNotice error={transition.error} /> : null}
      </Card>
    </div>
  );
}

/* ------------------------------ export documents ------------------------ */

export function ExportDocumentsPanel() {
  const [documentType, setDocumentType] = useState<ExportDocumentType>('certificate_of_origin');
  const [subjectType, setSubjectType] = useState<LivestockSubjectType>('animal');
  const [subjectId, setSubjectId] = useState('');
  const [destinationCountry, setDestinationCountry] = useState('');
  const [hsCode, setHsCode] = useState('');

  const query = useApiQuery(
    subjectId.trim().length >= 4 ? `livestock-trade:export-docs:${subjectType}:${subjectId.trim()}` : null,
    () =>
      listExportDocuments({ subjectType, subjectId: subjectId.trim() }).then((res) => res.data),
    { fallbackData: FALLBACK_EXPORT_DOCS, enabled: subjectId.trim().length >= 4 }
  );

  const generate = useApiMutation<void, ExportDocument>({
    mutationFn: () =>
      generateExportDocument({
        documentType,
        subjectType,
        subjectId: subjectId.trim(),
        destinationCountry: destinationCountry.trim() || undefined,
        hsCode: hsCode.trim() || undefined
      }).then((res) => res.data),
    onSuccess: () => query.refresh()
  });

  return (
    <Card title="Export documents (AfCFTA drafts)">
      <p className="small muted">
        Generated payloads are drafts for review — nothing is submitted to any authority.
        Regenerating increments the version per subject.
      </p>
      <div className="form-grid cols-2">
        <Field id="ed-type" label="Document type">
          <Select
            id="ed-type"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as ExportDocumentType)}
          >
            {EXPORT_DOCUMENT_TYPES.map((option) => (
              <option key={option} value={option}>
                {option.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="ed-subject-type" label="Subject type">
          <Select
            id="ed-subject-type"
            value={subjectType}
            onChange={(event) => setSubjectType(event.target.value as LivestockSubjectType)}
          >
            {LIVESTOCK_SUBJECT_TYPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="ed-subject" label="Subject ID">
          <TextInput
            id="ed-subject"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            placeholder="NG-BOV-KD-000123"
          />
        </Field>
        <Field id="ed-destination" label="Destination country (optional)">
          <TextInput
            id="ed-destination"
            value={destinationCountry}
            onChange={(event) => setDestinationCountry(event.target.value)}
            placeholder="e.g. Ghana"
          />
        </Field>
        <Field id="ed-hs" label="HS code (optional)">
          <TextInput
            id="ed-hs"
            value={hsCode}
            onChange={(event) => setHsCode(event.target.value)}
            placeholder="e.g. 0102"
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={subjectId.trim().length < 4 || generate.status === 'pending'}
          onClick={() => void generate.mutate()}
        >
          {generate.status === 'pending' ? 'Generating…' : 'Generate draft'}
        </button>
      </div>
      {generate.status === 'error' ? <ApiErrorNotice error={generate.error} /> : null}

      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      {subjectId.trim().length >= 4 ? (
        <QueryState
          isLoading={query.isLoading}
          error={query.source === 'fallback' ? undefined : query.error}
          data={query.data}
          onRetry={query.refresh}
          empty={<p className="small muted">No export documents for {subjectId.trim()} yet.</p>}
        >
          <ul className="row-list">
            {(query.data ?? []).map((doc) => (
              <li className="row-item" key={doc.id}>
                <div className="row-main small">
                  <strong>{doc.documentType.replace(/_/g, ' ')}</strong> · v{doc.version} ·{' '}
                  {dateLabel(doc.createdAt)}
                  {doc.payload.certificateOfOrigin.destinationCountry
                    ? ` · → ${doc.payload.certificateOfOrigin.destinationCountry}`
                    : ''}
                </div>
                <StatusBadge tone="neutral" ariaLabel={`Watermark: ${EXPORT_DOCUMENT_WATERMARK}`}>
                  DRAFT
                </StatusBadge>
              </li>
            ))}
          </ul>
        </QueryState>
      ) : (
        <p className="small muted">Enter a subject ID to list its document versions.</p>
      )}
    </Card>
  );
}

/* -------------------------------- liens --------------------------------- */

import { DISBURSEMENT_MILESTONES, LIVESTOCK_SPECIES } from '@agric-platform/shared';
import type {
  AggregationPoint,
  DisbursementMilestone,
  DonorDisbursement,
  InsuranceClaim,
  InsurancePolicy,
  LivestockLien,
  LivestockSpecies,
  UserRole
} from '@agric-platform/shared';
import {
  assignLotToPoint,
  bindInsurancePolicy,
  confirmDisbursement,
  createAggregationPoint,
  deactivateAggregationPoint,
  dischargeLien,
  listAggregationPoints,
  listInsuranceClaims,
  listMyDisbursements,
  listMyInsurancePolicies,
  listMyLiens,
  listMyLots,
  quoteInsurancePolicy,
  registerLien,
  releaseDisbursement,
  scheduleDisbursement,
  submitInsuranceClaim
} from '@/lib/api/endpoints';
import { downloadLivestockComplianceExport } from '@/lib/api/export';
import {
  demoAggregationPoints,
  demoDisbursements,
  demoInsuranceClaims,
  demoInsurancePolicies,
  demoLiens,
  demoLots
} from '@/lib/content';
import { TextArea } from '@/components/forms';
import { RoleGate } from '@/components/livestock-health-live';

const LENDER_ROLES: UserRole[] = ['lender', 'admin'];

export function LiensConsole() {
  const { hydrated } = useAppState();
  const [subjectType, setSubjectType] = useState<LivestockSubjectType>('animal');
  const [subjectId, setSubjectId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [terms, setTerms] = useState('');

  const query = useApiQuery(
    hydrated ? 'livestock-finance:liens:mine' : null,
    () => listMyLiens().then((res) => res.data),
    { fallbackData: demoLiens, enabled: hydrated }
  );

  const principalKobo = nairaToKobo(principal);
  const valid =
    subjectId.trim().length >= 4 &&
    principalKobo !== undefined &&
    principalKobo >= 1 &&
    terms.trim().length >= 4;

  const register = useApiMutation<void, LivestockLien>({
    mutationFn: () =>
      registerLien({
        subjectType,
        subjectId: subjectId.trim(),
        principalKobo: principalKobo!,
        terms: terms.trim()
      }).then((res) => res.data),
    onSuccess: () => {
      setSubjectId('');
      setPrincipal('');
      setTerms('');
      query.refresh();
    }
  });

  const discharge = useApiMutation<string, LivestockLien>({
    mutationFn: (lienId) => dischargeLien(lienId).then((res) => res.data),
    onSuccess: () => query.refresh()
  });

  return (
    <Card title="Liens console">
      <RoleGate roles={LENDER_ROLES} hint="Registering and discharging liens needs the lender role.">
        {query.source === 'fallback' ? <OfflineDataNotice /> : null}
        <div className="form-grid cols-2">
          <Field id="ln-type" label="Subject type">
            <Select
              id="ln-type"
              value={subjectType}
              onChange={(event) => setSubjectType(event.target.value as LivestockSubjectType)}
            >
              {LIVESTOCK_SUBJECT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ln-subject" label="Subject ID">
            <TextInput
              id="ln-subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              placeholder="NG-BOV-KD-000123"
            />
          </Field>
          <Field id="ln-principal" label="Principal (₦)">
            <TextInput
              id="ln-principal"
              inputMode="decimal"
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
              placeholder="e.g. 300000"
            />
          </Field>
        </div>
        <Field id="ln-terms" label="Terms">
          <TextArea
            id="ln-terms"
            value={terms}
            onChange={(event) => setTerms(event.target.value)}
            placeholder="e.g. 6-month input credit; lien discharges on full repayment."
          />
        </Field>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!valid || register.status === 'pending'}
            onClick={() => void register.mutate()}
          >
            {register.status === 'pending' ? 'Registering…' : 'Register lien'}
          </button>
        </div>
        {register.status === 'error' ? <ApiErrorNotice error={register.error} /> : null}

        <QueryState
          isLoading={query.isLoading}
          error={query.source === 'fallback' ? undefined : query.error}
          data={query.data}
          onRetry={query.refresh}
          empty={<p className="small muted">No liens registered yet.</p>}
        >
          <ul className="row-list">
            {(query.data ?? []).map((lien) => (
              <li className="row-item" key={lien.id}>
                <div className="row-main small">
                  <strong>{lien.subjectId}</strong> · {formatKobo(lien.principalKobo)} · borrower{' '}
                  {lien.borrowerUserId} · {lien.terms}
                </div>
                <span className="cluster">
                  <AutoBadge value={lien.status} />
                  {lien.status === 'active' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={discharge.status === 'pending'}
                      onClick={() => void discharge.mutate(lien.id)}
                      aria-label={`Discharge lien ${lien.id}`}
                    >
                      Discharge
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
        {discharge.status === 'error' ? <ApiErrorNotice error={discharge.error} /> : null}
      </RoleGate>
    </Card>
  );
}

/* ------------------------------- insurance ------------------------------ */

export function InsurancePanel() {
  const { hydrated, role } = useAppState();
  const [subjectType, setSubjectType] = useState<LivestockSubjectType>('animal');
  const [subjectId, setSubjectId] = useState('');
  const [species, setSpecies] = useState<LivestockSpecies>('cattle');
  const [premium, setPremium] = useState('');
  const [coverage, setCoverage] = useState('');
  const [claimPolicyId, setClaimPolicyId] = useState('');
  const [claimAnimals, setClaimAnimals] = useState('');
  const [claimsFor, setClaimsFor] = useState<string | null>(null);

  const policies = useApiQuery(
    hydrated ? 'livestock-finance:policies:mine' : null,
    () => listMyInsurancePolicies().then((res) => res.data),
    { fallbackData: demoInsurancePolicies, enabled: hydrated }
  );

  const claims = useApiQuery(
    claimsFor ? `livestock-finance:claims:${claimsFor}` : null,
    () => listInsuranceClaims(claimsFor!).then((res) => res.data),
    // Offline fallback only — live claims from GET /api/v1/livestock-finance/insurance/claims.
    { fallbackData: demoInsuranceClaims, enabled: Boolean(claimsFor) }
  );

  const premiumKobo = nairaToKobo(premium);
  const coverageKobo = nairaToKobo(coverage);
  const quoteValid =
    subjectId.trim().length >= 4 &&
    premiumKobo !== undefined &&
    premiumKobo >= 1 &&
    coverageKobo !== undefined &&
    coverageKobo >= 1;

  const quote = useApiMutation<void, InsurancePolicy>({
    mutationFn: () =>
      quoteInsurancePolicy({
        subjectType,
        subjectId: subjectId.trim(),
        premiumKobo: premiumKobo!,
        coverageKobo: coverageKobo!
      }).then((res) => res.data),
    onSuccess: () => {
      setSubjectId('');
      setPremium('');
      setCoverage('');
      policies.refresh();
    }
  });

  const bind = useApiMutation<string, InsurancePolicy>({
    mutationFn: (policyId) => bindInsurancePolicy(policyId).then((res) => res.data),
    onSuccess: () => policies.refresh()
  });

  const claim = useApiMutation<void, InsuranceClaim>({
    mutationFn: () =>
      submitInsuranceClaim({
        policyId: claimPolicyId,
        animalIds: claimAnimals
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      }).then((res) => res.data),
    onSuccess: () => {
      setClaimAnimals('');
      claims.refresh();
    }
  });

  return (
    <div className="grid grid-2">
      <Card title="Quote and bind">
        {policies.source === 'fallback' ? <OfflineDataNotice /> : null}
        <div className="form-grid cols-2">
          <Field id="in-type" label="Subject type">
            <Select
              id="in-type"
              value={subjectType}
              onChange={(event) => setSubjectType(event.target.value as LivestockSubjectType)}
            >
              {LIVESTOCK_SUBJECT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="in-subject" label="Subject ID">
            <TextInput
              id="in-subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              placeholder="NG-BOV-KD-000123"
            />
          </Field>
          <Field id="in-species" label="Species">
            <Select
              id="in-species"
              value={species}
              onChange={(event) => setSpecies(event.target.value as LivestockSpecies)}
            >
              {LIVESTOCK_SPECIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="in-premium" label="Premium (₦)">
            <TextInput
              id="in-premium"
              inputMode="decimal"
              value={premium}
              onChange={(event) => setPremium(event.target.value)}
            />
          </Field>
          <Field id="in-coverage" label="Coverage (₦)">
            <TextInput
              id="in-coverage"
              inputMode="decimal"
              value={coverage}
              onChange={(event) => setCoverage(event.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!quoteValid || quote.status === 'pending'}
            onClick={() => void quote.mutate()}
          >
            {quote.status === 'pending' ? 'Quoting…' : 'Get quote'}
          </button>
        </div>
        {quote.status === 'error' ? <ApiErrorNotice error={quote.error} /> : null}

        <QueryState
          isLoading={policies.isLoading}
          error={policies.source === 'fallback' ? undefined : policies.error}
          data={policies.data}
          onRetry={policies.refresh}
          empty={<p className="small muted">No policies yet — request a quote above.</p>}
        >
          <ul className="row-list">
            {(policies.data ?? []).map((policy) => (
              <li className="row-item" key={policy.id}>
                <div className="row-main small">
                  <strong>{policy.subjectId}</strong> · {policy.species} · premium{' '}
                  {formatKobo(policy.premiumKobo)} · cover {formatKobo(policy.coverageKobo)}
                </div>
                <span className="cluster">
                  <AutoBadge value={policy.status} />
                  {policy.status === 'quote' ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      disabled={bind.status === 'pending'}
                      onClick={() => void bind.mutate(policy.id)}
                      aria-label={`Bind policy ${policy.id}`}
                    >
                      Bind
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    aria-expanded={claimsFor === policy.id}
                    onClick={() => {
                      setClaimsFor(claimsFor === policy.id ? null : policy.id);
                      setClaimPolicyId(policy.id);
                    }}
                  >
                    Claims
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
      </Card>

      <Card title="Claims">
        {claimsFor ? (
          <>
            {claims.source === 'fallback' ? <OfflineDataNotice /> : null}
            <p className="small muted">Policy {claimsFor}</p>
            <QueryState
              isLoading={claims.isLoading}
              error={claims.source === 'fallback' ? undefined : claims.error}
              data={claims.data}
              onRetry={claims.refresh}
              empty={<p className="small muted">No claims on this policy yet.</p>}
            >
              <ul className="row-list">
                {(claims.data ?? []).map((item) => (
                  <li className="row-item" key={item.id}>
                    <div className="row-main small">
                      <strong>{item.id}</strong> · {item.animalIds.join(', ')}
                      {item.amountKobo !== undefined ? ` · ${formatKobo(item.amountKobo)}` : ''}
                      {item.notes ? ` · ${item.notes}` : ''}
                    </div>
                    <span className="cluster">
                      <AutoBadge value={item.status} />
                      {item.trigger === 'recall' ? (
                        <StatusBadge
                          tone="warning"
                          ariaLabel={`Recall-triggered claim${item.recallId ? `, recall ${item.recallId}` : ''}`}
                        >
                          recall-triggered{item.recallId ? ` · ${item.recallId}` : ''}
                        </StatusBadge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </QueryState>
            <Field id="cl-animals" label="Claim animals (comma separated IDs)">
              <TextInput
                id="cl-animals"
                value={claimAnimals}
                onChange={(event) => setClaimAnimals(event.target.value)}
                placeholder="NG-BOV-KD-000123"
              />
            </Field>
            <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={claimAnimals.trim().length < 4 || claim.status === 'pending'}
                onClick={() => void claim.mutate()}
              >
                {claim.status === 'pending' ? 'Submitting…' : 'Submit claim'}
              </button>
            </div>
            {claim.status === 'error' ? <ApiErrorNotice error={claim.error} /> : null}
          </>
        ) : (
          <p className="small muted">
            Open “Claims” on a policy to view and submit claims. Claims created automatically from a
            recall are marked recall-triggered.
          </p>
        )}
        {role === 'insurer' ? (
          <p className="small muted">Assess and settle actions are available on submitted claims via the API; this console is per-policy.</p>
        ) : null}
      </Card>
    </div>
  );
}

/* ------------------------------ disbursements --------------------------- */

const DONOR_ROLES: UserRole[] = ['donor', 'admin'];

export function DisbursementsPanel() {
  const { hydrated } = useAppState();
  const [programmeId, setProgrammeId] = useState('');
  const [milestone, setMilestone] = useState<DisbursementMilestone>('registration');
  const [amount, setAmount] = useState('');
  const [beneficiary, setBeneficiary] = useState('');

  const query = useApiQuery(
    hydrated ? 'livestock-finance:disbursements:mine' : null,
    () => listMyDisbursements().then((res) => res.data),
    { fallbackData: demoDisbursements, enabled: hydrated }
  );

  const amountKobo = nairaToKobo(amount);
  const valid =
    programmeId.trim().length >= 3 &&
    amountKobo !== undefined &&
    amountKobo >= 1 &&
    beneficiary.trim().length >= 3;

  const schedule = useApiMutation<void, DonorDisbursement>({
    mutationFn: () =>
      scheduleDisbursement({
        programmeId: programmeId.trim(),
        milestone,
        amountKobo: amountKobo!,
        beneficiaryUserId: beneficiary.trim()
      }).then((res) => res.data),
    onSuccess: () => {
      setAmount('');
      setBeneficiary('');
      query.refresh();
    }
  });

  const act = useApiMutation<{ id: string; action: 'release' | 'confirm' }, DonorDisbursement>({
    mutationFn: ({ id, action }) =>
      action === 'release'
        ? releaseDisbursement(id).then((res) => res.data)
        : confirmDisbursement(id).then((res) => res.data),
    onSuccess: () => query.refresh()
  });

  return (
    <Card title="Donor disbursements">
      <RoleGate roles={DONOR_ROLES} hint="Scheduling disbursements needs the donor role.">
        {query.source === 'fallback' ? <OfflineDataNotice /> : null}
        <div className="form-grid cols-2">
          <Field id="db-programme" label="Programme ID">
            <TextInput
              id="db-programme"
              value={programmeId}
              onChange={(event) => setProgrammeId(event.target.value)}
              placeholder="e.g. prog-women-poultry"
            />
          </Field>
          <Field id="db-milestone" label="Milestone">
            <Select
              id="db-milestone"
              value={milestone}
              onChange={(event) => setMilestone(event.target.value as DisbursementMilestone)}
            >
              {DISBURSEMENT_MILESTONES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="db-amount" label="Amount (₦)">
            <TextInput
              id="db-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field id="db-beneficiary" label="Beneficiary (user ID)">
            <TextInput
              id="db-beneficiary"
              value={beneficiary}
              onChange={(event) => setBeneficiary(event.target.value)}
              placeholder="e.g. user-adamu"
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!valid || schedule.status === 'pending'}
            onClick={() => void schedule.mutate()}
          >
            {schedule.status === 'pending' ? 'Scheduling…' : 'Schedule disbursement'}
          </button>
        </div>
        {schedule.status === 'error' ? <ApiErrorNotice error={schedule.error} /> : null}

        <QueryState
          isLoading={query.isLoading}
          error={query.source === 'fallback' ? undefined : query.error}
          data={query.data}
          onRetry={query.refresh}
          empty={<p className="small muted">No disbursements scheduled yet.</p>}
        >
          <ul className="row-list">
            {(query.data ?? []).map((item) => (
              <li className="row-item" key={item.id}>
                <div className="row-main small">
                  <strong>{formatKobo(item.amountKobo)}</strong> · {item.programmeId} ·{' '}
                  {item.beneficiaryUserId} ·{' '}
                  <StatusBadge tone="info" ariaLabel={`Milestone: ${item.milestone}`}>
                    {item.milestone}
                  </StatusBadge>
                </div>
                <span className="cluster">
                  <AutoBadge value={item.status} />
                  {item.status === 'scheduled' ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      disabled={act.status === 'pending'}
                      onClick={() => void act.mutate({ id: item.id, action: 'release' })}
                      aria-label={`Release disbursement ${item.id}`}
                    >
                      Release
                    </button>
                  ) : null}
                  {item.status === 'released' ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={act.status === 'pending'}
                      onClick={() => void act.mutate({ id: item.id, action: 'confirm' })}
                      aria-label={`Confirm disbursement ${item.id}`}
                    >
                      Confirm
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
      </RoleGate>
    </Card>
  );
}

/* ---------------------------- aggregation points ------------------------ */

const PARTNER_ROLES: UserRole[] = ['partner', 'admin'];

export function AggregationPointsPanel() {
  const { hydrated } = useAppState();
  const [name, setName] = useState('');
  const [state, setState] = useState('');
  const [lga, setLga] = useState('');
  const [capacity, setCapacity] = useState('');
  const [assignPoint, setAssignPoint] = useState('');
  const [assignLot, setAssignLot] = useState('');

  const points = useApiQuery(
    hydrated ? 'livestock-partners:points' : null,
    () => listAggregationPoints().then((res) => res.data),
    { fallbackData: demoAggregationPoints, enabled: hydrated }
  );

  const lots = useApiQuery(
    hydrated ? 'livestock:lots:mine:for-assign' : null,
    () => listMyLots().then((res) => res.data),
    { fallbackData: demoLots, enabled: hydrated }
  );

  const capacityNumber = capacity ? Number(capacity) : undefined;
  const valid =
    name.trim().length >= 3 &&
    state.length > 0 &&
    lga.trim().length >= 2 &&
    (capacityNumber === undefined || (Number.isInteger(capacityNumber) && capacityNumber >= 1));

  const create = useApiMutation<void, AggregationPoint>({
    mutationFn: () =>
      createAggregationPoint({
        name: name.trim(),
        state,
        lga: lga.trim(),
        capacity: capacityNumber
      }).then((res) => res.data),
    onSuccess: () => {
      setName('');
      setLga('');
      setCapacity('');
      points.refresh();
    }
  });

  const assign = useApiMutation<void, AggregationPoint>({
    mutationFn: () => assignLotToPoint(assignPoint, assignLot).then((res) => res.data),
    onSuccess: () => {
      setAssignLot('');
      points.refresh();
    }
  });

  const deactivate = useApiMutation<string, AggregationPoint>({
    mutationFn: (pointId) => deactivateAggregationPoint(pointId).then((res) => res.data),
    onSuccess: () => points.refresh()
  });

  return (
    <Card title="Aggregation points">
      <RoleGate roles={PARTNER_ROLES} hint="Registering aggregation points needs the partner role.">
        {points.source === 'fallback' ? <OfflineDataNotice /> : null}
        <div className="form-grid cols-2">
          <Field id="ap-name" label="Name">
            <TextInput
              id="ap-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Zaria Livestock Collection Hub"
            />
          </Field>
          <Field id="ap-state" label="State">
            <Select id="ap-state" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ap-lga" label="LGA">
            <TextInput id="ap-lga" value={lga} onChange={(event) => setLga(event.target.value)} />
          </Field>
          <Field id="ap-capacity" label="Capacity (optional headcount)">
            <TextInput
              id="ap-capacity"
              inputMode="numeric"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!valid || create.status === 'pending'}
            onClick={() => void create.mutate()}
          >
            {create.status === 'pending' ? 'Registering…' : 'Register point'}
          </button>
        </div>
        {create.status === 'error' ? <ApiErrorNotice error={create.error} /> : null}

        <QueryState
          isLoading={points.isLoading}
          error={points.source === 'fallback' ? undefined : points.error}
          data={points.data}
          onRetry={points.refresh}
          empty={<p className="small muted">No aggregation points registered yet.</p>}
        >
          <ul className="row-list">
            {(points.data ?? []).map((point) => (
              <li className="row-item" key={point.id}>
                <div className="row-main small">
                  <strong>{point.name}</strong> · {point.state}, {point.lga}
                  {point.capacity ? ` · capacity ${point.capacity}` : ''} · {point.lotIds.length}{' '}
                  lot{point.lotIds.length === 1 ? '' : 's'}
                  {point.lotIds.length > 0 ? ` (${point.lotIds.join(', ')})` : ''}
                </div>
                <span className="cluster">
                  <AutoBadge value={point.status} />
                  {point.status === 'active' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={deactivate.status === 'pending'}
                      onClick={() => void deactivate.mutate(point.id)}
                      aria-label={`Deactivate ${point.name}`}
                    >
                      Deactivate
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>

        <div className="cluster" style={{ marginTop: '0.75rem' }}>
          <Field id="ap-assign-point" label="Point">
            <Select
              id="ap-assign-point"
              value={assignPoint}
              onChange={(event) => setAssignPoint(event.target.value)}
            >
              <option value="">Select point…</option>
              {(points.data ?? [])
                .filter((point) => point.status === 'active')
                .map((point) => (
                  <option key={point.id} value={point.id}>
                    {point.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field id="ap-assign-lot" label="My lot">
            <Select
              id="ap-assign-lot"
              value={assignLot}
              onChange={(event) => setAssignLot(event.target.value)}
            >
              <option value="">Select lot…</option>
              {(lots.data ?? []).map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.id} ({lot.quantity} {lot.species})
                </option>
              ))}
            </Select>
          </Field>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={!assignPoint || !assignLot || assign.status === 'pending'}
            onClick={() => void assign.mutate()}
          >
            {assign.status === 'pending' ? 'Assigning…' : 'Assign lot'}
          </button>
        </div>
        {assign.status === 'error' ? <ApiErrorNotice error={assign.error} /> : null}
      </RoleGate>
    </Card>
  );
}

/* ------------------------------ compliance ------------------------------ */

const REGULATOR_ROLES: UserRole[] = ['regulator', 'admin'];

export function ComplianceExportCard() {
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<unknown>(undefined);

  const download = async () => {
    setStatus('pending');
    setError(undefined);
    try {
      await downloadLivestockComplianceExport({
        state: state || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined
      });
      setStatus('done');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  };

  return (
    <Card title="Compliance CSV export">
      <RoleGate roles={REGULATOR_ROLES}>
        <p className="small muted">
          Sectioned CSV of registered animals and ownership transfers (audit-logged on the API).
        </p>
        <div className="form-grid cols-2">
          <Field id="cx-state" label="State (optional)">
            <Select id="cx-state" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">All states</option>
              {NIGERIAN_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="cx-from" label="From (optional)">
            <TextInput
              id="cx-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field id="cx-to" label="To (optional)">
            <TextInput
              id="cx-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          {status === 'done' ? <StatusBadge tone="success">downloaded</StatusBadge> : null}
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={status === 'pending'}
            onClick={() => void download()}
          >
            {status === 'pending' ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
        {status === 'error' ? <ApiErrorNotice error={error} onRetry={() => void download()} /> : null}
      </RoleGate>
    </Card>
  );
}

/* ------------------------------- trade hub ------------------------------ */

import { T } from '@/lib/i18n';
import { Section } from '@/components/ui';

/** /livestock/trade — certified trade, finance, compliance and aggregation surfaces. */
export function LivestockTradeHub() {
  return (
    <>
      <Section kicker={<T k="livestock.listingsKicker" />} title={<T k="livestock.listingsTitle" />}>
        <CertifiedListingsPanel />
      </Section>

      <Section kicker={<T k="livestock.offtakeKicker" />} title={<T k="livestock.offtakeTitle" />}>
        <OfftakePanel />
      </Section>

      <Section kicker={<T k="livestock.exportKicker" />} title={<T k="livestock.exportTitle" />}>
        <ExportDocumentsPanel />
      </Section>

      <Section kicker={<T k="livestock.liensKicker" />} title={<T k="livestock.liensTitle" />}>
        <LiensConsole />
      </Section>

      <Section kicker={<T k="livestock.insuranceKicker" />} title={<T k="livestock.insuranceTitle" />}>
        <InsurancePanel />
      </Section>

      <Section
        kicker={<T k="livestock.disbursementsKicker" />}
        title={<T k="livestock.disbursementsTitle" />}
      >
        <DisbursementsPanel />
      </Section>

      <Section
        kicker={<T k="livestock.aggregationKicker" />}
        title={<T k="livestock.aggregationTitle" />}
      >
        <div className="grid grid-2">
          <AggregationPointsPanel />
          <ComplianceExportCard />
        </div>
      </Section>
    </>
  );
}
