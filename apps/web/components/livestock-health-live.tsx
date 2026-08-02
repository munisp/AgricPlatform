'use client';

import { useState } from 'react';
import {
  DISEASE_FLAG_STATUSES,
  HEALTH_RECORD_TYPES,
  LIVESTOCK_SPECIES,
  MOVEMENT_PURPOSES,
  MOVEMENT_TRANSPORT_MODES,
  NIGERIAN_STATES,
  RECALL_SCOPES,
  RECALL_STATUSES
} from '@agric-platform/shared';
import type {
  AnimalHealthRecord,
  AnimalMovement,
  DiseaseFlag,
  DiseaseFlagStatus,
  HealthRecordType,
  LivestockSpecies,
  MovementPermit,
  MovementPurpose,
  MovementTransportMode,
  RecallScope,
  RecallStatus,
  UserRole
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  confirmDiseaseFlag,
  fetchDiseaseMap,
  fetchRecall,
  initiateRecall,
  issueMovementPermit,
  listAnimalHealthRecords,
  listAnimalMovements,
  listDiseaseFlags,
  listRecalls,
  recordHealth,
  recordMovementArrival,
  reportDiseaseFlag,
  resolveRecall,
  retractDiseaseFlag,
  reverseHealthRecord,
  revokeMovementPermit,
  startMovement,
  verifyHealthRecord,
  verifyMovementPermit
} from '@/lib/api/endpoints';
import type {
  HealthRecordVerification,
  PermitVerificationResult,
  RecallWithAnimals
} from '@/lib/api/endpoints';
import {
  demoDiseaseFlags,
  demoDiseaseMap,
  demoHealthRecords,
  demoHealthVerification,
  demoMovements,
  demoPermitVerification,
  demoRecallDetail,
  demoRecalls
} from '@/lib/content';
import { Field, Select, TextArea, TextInput } from '@/components/forms';
import { AutoBadge, Card, StatusBadge } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/livestock-health/*.
const FALLBACK_RECORDS = demoHealthRecords;
const FALLBACK_MOVEMENTS = demoMovements;
const FALLBACK_RECALLS = demoRecalls;
const FALLBACK_FLAGS = demoDiseaseFlags;
const FALLBACK_DISEASE_MAP = demoDiseaseMap;

/** Renders children only for the given roles; otherwise a switch-role hint. */
export function RoleGate({
  roles,
  children,
  hint
}: {
  roles: UserRole[];
  children: React.ReactNode;
  hint?: string;
}) {
  const { role } = useAppState();
  if (!roles.includes(role)) {
    return (
      <p className="small muted" data-testid="role-gate-hint">
        {hint ??
          `This action needs the ${roles.join(' or ')} role — use the role preview in the header.`}
      </p>
    );
  }
  return <>{children}</>;
}

function dateLabel(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'medium' });
}

/* ------------------------ record vaccination/treatment ------------------ */

const VET_ROLES: UserRole[] = ['vet', 'admin'];

export function RecordHealthForm({
  animalId: initialAnimalId = '',
  onRecorded
}: {
  animalId?: string;
  onRecorded?: () => void;
}) {
  const [animalId, setAnimalId] = useState(initialAnimalId);
  const [recordType, setRecordType] = useState<HealthRecordType>('vaccination');
  const [product, setProduct] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [dose, setDose] = useState('');
  const [administeredAt, setAdministeredAt] = useState('');
  const [withdrawalUntil, setWithdrawalUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [savedRecord, setSavedRecord] = useState<AnimalHealthRecord | null>(null);
  const [verification, setVerification] = useState<HealthRecordVerification | null>(null);

  const valid =
    animalId.trim().length >= 4 &&
    product.trim().length >= 2 &&
    batchNumber.trim().length >= 2 &&
    dose.trim().length >= 1 &&
    administeredAt.length > 0;

  const record = useApiMutation<void, AnimalHealthRecord>({
    mutationFn: () =>
      recordHealth({
        animalId: animalId.trim(),
        recordType,
        product: product.trim(),
        batchNumber: batchNumber.trim(),
        dose: dose.trim(),
        administeredAt: new Date(administeredAt).toISOString(),
        withdrawalUntil: withdrawalUntil ? new Date(withdrawalUntil).toISOString() : undefined,
        notes: notes.trim() || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.health.recorded',
      label: () => `${recordType}: ${product.trim()}`,
      method: 'POST',
      path: () => '/livestock-health/records',
      payload: () => ({
        animalId: animalId.trim(),
        recordType,
        product: product.trim(),
        batchNumber: batchNumber.trim(),
        dose: dose.trim(),
        administeredAt: new Date(administeredAt).toISOString()
      })
    },
    onSuccess: (created) => {
      setSavedRecord(created);
      setVerification(null);
      onRecorded?.();
    }
  });

  const verify = useApiMutation<void, HealthRecordVerification>({
    mutationFn: () =>
      savedRecord
        ? verifyHealthRecord(savedRecord.id).then((res) => res.data)
        : Promise.reject(new Error('No record to verify')),
    onSuccess: (result) => setVerification(result)
  });

  return (
    <Card title="Record vaccination or treatment">
      <RoleGate roles={VET_ROLES}>
        <div className="form-grid cols-2">
          <Field id="hr-animal" label="Animal ID">
            <TextInput
              id="hr-animal"
              value={animalId}
              onChange={(event) => setAnimalId(event.target.value)}
              placeholder="NG-BOV-KD-000123"
            />
          </Field>
          <Field id="hr-type" label="Record type">
            <Select
              id="hr-type"
              value={recordType}
              onChange={(event) => setRecordType(event.target.value as HealthRecordType)}
            >
              {HEALTH_RECORD_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="hr-product" label="Product" hint="Vaccine or drug name (e.g. FMD, PPR).">
            <TextInput
              id="hr-product"
              value={product}
              onChange={(event) => setProduct(event.target.value)}
              placeholder="e.g. FMD"
            />
          </Field>
          <Field id="hr-batch" label="Batch number">
            <TextInput
              id="hr-batch"
              value={batchNumber}
              onChange={(event) => setBatchNumber(event.target.value)}
              placeholder="e.g. FMD-2026-041"
            />
          </Field>
          <Field id="hr-dose" label="Dose">
            <TextInput
              id="hr-dose"
              value={dose}
              onChange={(event) => setDose(event.target.value)}
              placeholder="e.g. 2 ml"
            />
          </Field>
          <Field id="hr-administered" label="Administered at">
            <TextInput
              id="hr-administered"
              type="date"
              value={administeredAt}
              onChange={(event) => setAdministeredAt(event.target.value)}
            />
          </Field>
          {recordType === 'treatment' ? (
            <Field id="hr-withdrawal" label="Withdrawal until (optional)">
              <TextInput
                id="hr-withdrawal"
                type="date"
                value={withdrawalUntil}
                onChange={(event) => setWithdrawalUntil(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
        <Field id="hr-notes" label="Notes (optional)">
          <TextArea id="hr-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          {record.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || record.status === 'pending'}
            onClick={() => void record.mutate()}
          >
            {record.status === 'pending' ? 'Signing…' : 'Sign and save record'}
          </button>
        </div>
        {record.status === 'error' ? <ApiErrorNotice error={record.error} /> : null}

        {savedRecord ? (
          <div className="notice notice-info" role="status" data-testid="health-record-signature">
            <p className="small" style={{ margin: 0 }}>
              Record <strong>{savedRecord.id}</strong> signed at{' '}
              {new Date(savedRecord.signedAt).toLocaleString('en-NG')}.
            </p>
            <p className="small muted" style={{ wordBreak: 'break-all' }}>
              HMAC signature: <code>{savedRecord.signature}</code>
            </p>
            <div className="cluster">
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={verify.status === 'pending'}
                onClick={() => void verify.mutate()}
              >
                {verify.status === 'pending' ? 'Verifying…' : 'Verify signature'}
              </button>
              {verification ? (
                <StatusBadge tone={verification.ok ? 'success' : 'critical'}>
                  {verification.ok
                    ? `signature valid${verification.reversed ? ' · reversed' : ''}`
                    : 'signature mismatch'}
                </StatusBadge>
              ) : null}
            </div>
          </div>
        ) : null}
      </RoleGate>
    </Card>
  );
}

/* ------------------------------ health ledger --------------------------- */

export function HealthLedger({ animalId }: { animalId: string }) {
  const [verification, setVerification] = useState<HealthRecordVerification | null>(null);
  const query = useApiQuery(
    animalId ? `livestock:health-records:${animalId}` : null,
    () => listAnimalHealthRecords(animalId).then((res) => res.data),
    { fallbackData: FALLBACK_RECORDS, enabled: Boolean(animalId) }
  );

  const verify = useApiMutation<string, HealthRecordVerification>({
    mutationFn: (recordId) => verifyHealthRecord(recordId).then((res) => res.data),
    onSuccess: (result) => setVerification(result)
  });

  if (!animalId) {
    return <p className="small muted">Enter an animal ID above to load its health ledger.</p>;
  }

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<p className="small muted">No health records yet for {animalId}.</p>}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Product / batch</th>
                <th>Dose</th>
                <th>Vet</th>
                <th>Entry</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {(query.data ?? []).map((record) => (
                <tr key={record.id}>
                  <td>{dateLabel(record.administeredAt)}</td>
                  <td>{record.recordType}</td>
                  <td>
                    {record.product} · {record.batchNumber}
                    {record.withdrawalUntil ? (
                      <span className="small muted">
                        {' '}
                        · withdrawal until {dateLabel(record.withdrawalUntil)}
                      </span>
                    ) : null}
                  </td>
                  <td>{record.dose}</td>
                  <td>{record.vetUserId}</td>
                  <td>
                    {record.reversalOfId ? (
                      <StatusBadge tone="critical">reversal of {record.reversalOfId}</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">original</StatusBadge>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={verify.status === 'pending'}
                      onClick={() => void verify.mutate(record.id)}
                      aria-label={`Verify signature of record ${record.id}`}
                    >
                      Verify
                    </button>
                    {verification?.recordId === record.id ? (
                      <StatusBadge tone={verification.ok ? 'success' : 'critical'}>
                        {verification.ok ? 'valid' : 'mismatch'}
                      </StatusBadge>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </>
  );
}

/** Ledger with an animal-ID picker (used by the health page). */
export function HealthLedgerBrowser() {
  const [animalId, setAnimalId] = useState('');
  return (
    <Card title="Health ledger (append-only)">
      <Field id="ledger-animal" label="Animal ID">
        <TextInput
          id="ledger-animal"
          value={animalId}
          onChange={(event) => setAnimalId(event.target.value)}
          placeholder="NG-BOV-KD-000123"
        />
      </Field>
      <HealthLedger animalId={animalId.trim()} />
    </Card>
  );
}

/* --------------------------- movements + permits ------------------------ */

export function MovementPanel() {
  const [animalId, setAnimalId] = useState('');
  const [lotId, setLotId] = useState('');
  const [subjectAnimal, setSubjectAnimal] = useState('');
  const [fromState, setFromState] = useState('');
  const [toState, setToState] = useState('');
  const [transportMode, setTransportMode] = useState<MovementTransportMode>('trek');
  const [purpose, setPurpose] = useState<MovementPurpose>('grazing');
  const [permitId, setPermitId] = useState('');

  const query = useApiQuery(
    subjectAnimal ? `livestock:movements:${subjectAnimal}` : null,
    () => listAnimalMovements(subjectAnimal).then((res) => res.data),
    { fallbackData: FALLBACK_MOVEMENTS, enabled: Boolean(subjectAnimal) }
  );

  const start = useApiMutation<void, AnimalMovement>({
    mutationFn: () =>
      startMovement({
        animalId: animalId.trim() || undefined,
        lotId: lotId.trim() || undefined,
        fromState,
        toState,
        transportMode,
        purpose,
        permitId: permitId.trim() || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.movement.started',
      label: () => `Movement ${fromState} → ${toState}`,
      method: 'POST',
      path: () => '/livestock-health/movements',
      payload: () => ({
        animalId: animalId.trim() || undefined,
        lotId: lotId.trim() || undefined,
        fromState,
        toState,
        transportMode,
        purpose
      })
    },
    onSuccess: () => query.refresh()
  });

  const arrive = useApiMutation<string, AnimalMovement>({
    mutationFn: (movementId) => recordMovementArrival(movementId).then((res) => res.data),
    onSuccess: () => query.refresh()
  });

  const exactlyOneSubject = Boolean(animalId.trim()) !== Boolean(lotId.trim());
  const valid = exactlyOneSubject && fromState.length > 0 && toState.length > 0;

  return (
    <Card title="Movement log">
      <div className="form-grid cols-2">
        <Field id="mv-animal" label="Animal ID">
          <TextInput
            id="mv-animal"
            value={animalId}
            onChange={(event) => setAnimalId(event.target.value)}
            placeholder="NG-BOV-KD-000123"
          />
        </Field>
        <Field id="mv-lot" label="Lot ID (or animal)">
          <TextInput
            id="mv-lot"
            value={lotId}
            onChange={(event) => setLotId(event.target.value)}
            placeholder="LOT-AVI-KD-000007"
          />
        </Field>
        <Field id="mv-from" label="From state">
          <Select id="mv-from" value={fromState} onChange={(event) => setFromState(event.target.value)}>
            <option value="">Select state…</option>
            {NIGERIAN_STATES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="mv-to" label="To state">
          <Select id="mv-to" value={toState} onChange={(event) => setToState(event.target.value)}>
            <option value="">Select state…</option>
            {NIGERIAN_STATES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="mv-mode" label="Transport">
          <Select
            id="mv-mode"
            value={transportMode}
            onChange={(event) => setTransportMode(event.target.value as MovementTransportMode)}
          >
            {MOVEMENT_TRANSPORT_MODES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="mv-purpose" label="Purpose">
          <Select
            id="mv-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as MovementPurpose)}
          >
            {MOVEMENT_PURPOSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="mv-permit" label="Permit ID (optional)">
          <TextInput
            id="mv-permit"
            value={permitId}
            onChange={(event) => setPermitId(event.target.value)}
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={!valid || start.status === 'pending'}
          onClick={() => void start.mutate()}
        >
          {start.status === 'pending' ? 'Starting…' : 'Start movement'}
        </button>
      </div>
      {start.status === 'error' ? <ApiErrorNotice error={start.error} /> : null}

      <Field id="mv-history" label="Movement history for animal">
        <TextInput
          id="mv-history"
          value={subjectAnimal}
          onChange={(event) => setSubjectAnimal(event.target.value)}
          placeholder="NG-BOV-KD-000123"
        />
      </Field>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      {subjectAnimal ? (
        <QueryState
          isLoading={query.isLoading}
          error={query.source === 'fallback' ? undefined : query.error}
          data={query.data}
          onRetry={query.refresh}
          empty={<p className="small muted">No movements recorded for {subjectAnimal}.</p>}
        >
          <ul className="row-list">
            {(query.data ?? []).map((movement) => (
              <li className="row-item" key={movement.id}>
                <div className="row-main small">
                  {movement.fromState} → {movement.toState} · {movement.transportMode} ·{' '}
                  {movement.purpose} · departed {dateLabel(movement.departedAt)}
                </div>
                {movement.arrivedAt ? (
                  <StatusBadge tone="success">arrived {dateLabel(movement.arrivedAt)}</StatusBadge>
                ) : (
                  <span className="cluster">
                    <StatusBadge tone="warning">in transit</StatusBadge>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={arrive.status === 'pending'}
                      onClick={() => void arrive.mutate(movement.id)}
                      aria-label={`Record arrival of movement ${movement.id}`}
                    >
                      Record arrival
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </QueryState>
      ) : null}
    </Card>
  );
}

const PERMIT_ROLES: UserRole[] = ['vet', 'regulator', 'admin'];

export function PermitPanel() {
  const [animalIds, setAnimalIds] = useState('');
  const [fromState, setFromState] = useState('');
  const [toState, setToState] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [verifyInput, setVerifyInput] = useState('');
  const [verification, setVerification] = useState<PermitVerificationResult | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [issued, setIssued] = useState<MovementPermit | null>(null);

  const issue = useApiMutation<void, MovementPermit>({
    mutationFn: () =>
      issueMovementPermit({
        animalIds: animalIds.trim() ? animalIds.split(',').map((id) => id.trim()) : undefined,
        fromState,
        toState,
        validFrom: new Date(validFrom).toISOString(),
        validUntil: new Date(validUntil).toISOString()
      }).then((res) => res.data),
    onSuccess: (permit) => setIssued(permit)
  });

  const verify = useApiMutation<void, PermitVerificationResult>({
    mutationFn: () => verifyMovementPermit(verifyInput.trim()).then((res) => res.data),
    onSuccess: (result) => {
      setVerification(result);
      setRevokeReason('');
    }
  });

  const revoke = useApiMutation<void, MovementPermit>({
    mutationFn: () =>
      verification
        ? revokeMovementPermit(verification.permit.id, revokeReason.trim()).then((res) => res.data)
        : Promise.reject(new Error('Verify a permit first')),
    onSuccess: (permit) =>
      setVerification((current) =>
        current ? { ...current, permit, verification: 'revoked' } : current
      )
  });

  const issueValid =
    fromState.length > 0 && toState.length > 0 && validFrom.length > 0 && validUntil.length > 0;

  const verificationTone =
    verification?.verification === 'valid'
      ? 'success'
      : verification?.verification === 'expired'
        ? 'warning'
        : 'critical';

  return (
    <Card title="Movement permits">
      <RoleGate roles={PERMIT_ROLES} hint="Issuing and revoking permits needs the vet or regulator role.">
        <div className="form-grid cols-2">
          <Field id="pm-animals" label="Animal IDs (comma separated)">
            <TextInput
              id="pm-animals"
              value={animalIds}
              onChange={(event) => setAnimalIds(event.target.value)}
              placeholder="NG-BOV-KD-000123"
            />
          </Field>
          <Field id="pm-from" label="From state">
            <Select id="pm-from" value={fromState} onChange={(event) => setFromState(event.target.value)}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="pm-to" label="To state">
            <Select id="pm-to" value={toState} onChange={(event) => setToState(event.target.value)}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="pm-valid-from" label="Valid from">
            <TextInput
              id="pm-valid-from"
              type="date"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
            />
          </Field>
          <Field id="pm-valid-until" label="Valid until">
            <TextInput
              id="pm-valid-until"
              type="date"
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!issueValid || issue.status === 'pending'}
            onClick={() => void issue.mutate()}
          >
            {issue.status === 'pending' ? 'Issuing…' : 'Issue permit'}
          </button>
        </div>
        {issued ? (
          <p className="notice notice-info" role="status">
            Permit <strong>{issued.permitNumber}</strong> issued ({issued.fromState} →{' '}
            {issued.toState}).
          </p>
        ) : null}
        {issue.status === 'error' ? <ApiErrorNotice error={issue.error} /> : null}
      </RoleGate>

      <hr aria-hidden="true" />
      <div className="cluster">
        <Field id="pm-verify" label="Verify permit (ID or number)">
          <TextInput
            id="pm-verify"
            value={verifyInput}
            onChange={(event) => setVerifyInput(event.target.value)}
            placeholder="PMT-KD-KN-3F9A2C71"
          />
        </Field>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={verifyInput.trim().length < 3 || verify.status === 'pending'}
          onClick={() => void verify.mutate()}
        >
          {verify.status === 'pending' ? 'Verifying…' : 'Verify permit'}
        </button>
      </div>
      {verify.status === 'error' ? <ApiErrorNotice error={verify.error} /> : null}
      {verification ? (
        <div data-testid="permit-verification">
          <div className="cluster" style={{ justifyContent: 'space-between' }}>
            <p className="small" style={{ margin: 0 }}>
              {verification.permit.permitNumber} · {verification.permit.fromState} →{' '}
              {verification.permit.toState} · valid {dateLabel(verification.permit.validFrom)} –{' '}
              {dateLabel(verification.permit.validUntil)} ·{' '}
              {verification.subjects.length} subject{verification.subjects.length === 1 ? '' : 's'}
            </p>
            <StatusBadge tone={verificationTone} ariaLabel={`Permit verification: ${verification.verification}`}>
              {verification.verification}
            </StatusBadge>
          </div>
          {verification.permit.revokedReason ? (
            <p className="small muted">Revoked: {verification.permit.revokedReason}</p>
          ) : null}
          <RoleGate roles={PERMIT_ROLES}>
            {verification.permit.status === 'issued' ? (
              <div className="cluster" style={{ marginTop: '0.5rem' }}>
                <Field id="pm-revoke-reason" label="Revoke reason">
                  <TextInput
                    id="pm-revoke-reason"
                    value={revokeReason}
                    onChange={(event) => setRevokeReason(event.target.value)}
                  />
                </Field>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={revokeReason.trim().length < 3 || revoke.status === 'pending'}
                  onClick={() => void revoke.mutate()}
                >
                  {revoke.status === 'pending' ? 'Revoking…' : 'Revoke permit'}
                </button>
              </div>
            ) : null}
          </RoleGate>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------ recall console -------------------------- */

const RECALL_ROLES: UserRole[] = ['regulator', 'admin'];

export function RecallConsole() {
  const [scope, setScope] = useState<RecallScope>('animal');
  const [subject, setSubject] = useState('');
  const [state, setState] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [reason, setReason] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | RecallStatus>('');
  const [initiated, setInitiated] = useState<RecallWithAnimals | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const list = useApiQuery(
    `livestock:recalls:${statusFilter}`,
    () => listRecalls({ status: statusFilter || undefined }).then((res) => res.data),
    { fallbackData: FALLBACK_RECALLS }
  );

  const detail = useApiQuery(
    detailId ? `livestock:recall:${detailId}` : null,
    () => fetchRecall(detailId!).then((res) => res.data),
    // Offline fallback only — live detail from GET /api/v1/livestock-health/recalls/:id.
    { fallbackData: demoRecallDetail, enabled: Boolean(detailId) }
  );

  const scopeValid =
    reason.trim().length >= 4 &&
    ((scope === 'animal' && subject.trim().length >= 4) ||
      (scope === 'lot' && subject.trim().length >= 4) ||
      (scope === 'owner' && subject.trim().length >= 3) ||
      (scope === 'region' && state.length > 0));

  const initiate = useApiMutation<void, RecallWithAnimals>({
    mutationFn: () =>
      initiateRecall({
        animalId: scope === 'animal' ? subject.trim() : undefined,
        lotId: scope === 'lot' ? subject.trim() : undefined,
        ownerUserId: scope === 'owner' ? subject.trim() : undefined,
        state: scope === 'region' ? state : undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        batchNumber: batchNumber.trim() || undefined,
        reason: reason.trim()
      }).then((res) => res.data),
    onSuccess: (result) => {
      setInitiated(result);
      list.refresh();
    }
  });

  const resolve = useApiMutation<string, unknown>({
    mutationFn: (recallId) => resolveRecall(recallId).then((res) => res.data),
    onSuccess: () => {
      list.refresh();
      detail.refresh();
    }
  });

  const recalls = (list.data ?? []).filter((recall) => !statusFilter || recall.status === statusFilter);

  return (
    <Card title="Recall console">
      <RoleGate roles={RECALL_ROLES}>
        {list.source === 'fallback' ? <OfflineDataNotice /> : null}
        <div className="form-grid cols-2">
          <Field id="rc-scope" label="Scope">
            <Select
              id="rc-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as RecallScope)}
            >
              {RECALL_SCOPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          {scope === 'region' ? (
            <Field id="rc-state" label="State">
              <Select id="rc-state" value={state} onChange={(event) => setState(event.target.value)}>
                <option value="">Select state…</option>
                {NIGERIAN_STATES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field
              id="rc-subject"
              label={scope === 'animal' ? 'Animal ID' : scope === 'lot' ? 'Lot ID' : 'Owner user ID'}
            >
              <TextInput
                id="rc-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </Field>
          )}
          <Field id="rc-from" label="From date (optional)">
            <TextInput
              id="rc-from"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </Field>
          <Field id="rc-to" label="To date (optional)">
            <TextInput
              id="rc-to"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
            />
          </Field>
          <Field id="rc-batch" label="Batch number (optional)">
            <TextInput
              id="rc-batch"
              value={batchNumber}
              onChange={(event) => setBatchNumber(event.target.value)}
            />
          </Field>
          <Field id="rc-reason" label="Reason">
            <TextInput
              id="rc-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!scopeValid || initiate.status === 'pending'}
            onClick={() => void initiate.mutate()}
          >
            {initiate.status === 'pending' ? 'Initiating…' : 'Initiate recall'}
          </button>
        </div>
        {initiate.status === 'error' ? <ApiErrorNotice error={initiate.error} /> : null}

        {initiated ? (
          <div className="notice notice-warning" role="status" data-testid="recall-preview">
            <strong>
              Recall {initiated.recall.id} initiated — {initiated.animals.length} affected animal
              {initiated.animals.length === 1 ? '' : 's'}:
            </strong>
            <ul className="small" style={{ marginBottom: 0 }}>
              {initiated.animals.map((entry) => (
                <li key={entry.animalId}>
                  {entry.animalId} (owner {entry.ownerUserId})
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="cluster" style={{ marginTop: '1rem' }}>
          <Field id="rc-filter" label="Filter recalls">
            <Select
              id="rc-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as '' | RecallStatus)}
            >
              <option value="">All statuses</option>
              {RECALL_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ul className="row-list">
          {recalls.map((recall) => (
            <li className="row-item" key={recall.id}>
              <div className="row-main small">
                <strong>{recall.id}</strong> · {recall.scope}
                {recall.state ? ` · ${recall.state}` : ''} · {recall.reason}
              </div>
              <span className="cluster">
                <AutoBadge value={recall.status} />
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  aria-expanded={detailId === recall.id}
                  onClick={() => setDetailId(detailId === recall.id ? null : recall.id)}
                >
                  {detailId === recall.id ? 'Hide animals' : 'View animals'}
                </button>
                {recall.status !== 'resolved' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={resolve.status === 'pending'}
                    onClick={() => void resolve.mutate(recall.id)}
                    aria-label={`Resolve recall ${recall.id}`}
                  >
                    Resolve
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {detailId && detail.data ? (
          <div className="notice notice-info" role="status">
            Recall {detail.data.recall.id}: {detail.data.animals.length} materialised animal
            {detail.data.animals.length === 1 ? '' : 's'} —{' '}
            {detail.data.animals.map((entry) => entry.animalId).join(', ') || 'none'}.
          </div>
        ) : null}
      </RoleGate>
    </Card>
  );
}

/* --------------------------- disease surveillance ----------------------- */

const CONFIRM_ROLES: UserRole[] = ['vet', 'regulator', 'admin'];

export function DiseaseSurveillanceBoard() {
  const { userId, role } = useAppState();
  const [disease, setDisease] = useState('');
  const [state, setState] = useState('');
  const [lga, setLga] = useState('');
  const [species, setSpecies] = useState<'' | LivestockSpecies>('');
  const [statusFilter, setStatusFilter] = useState<'' | DiseaseFlagStatus>('');
  const [retractReason, setRetractReason] = useState<Record<string, string>>({});

  const flags = useApiQuery(
    `livestock:disease-flags:${statusFilter}`,
    () => listDiseaseFlags({ status: statusFilter || undefined }).then((res) => res.data),
    { fallbackData: FALLBACK_FLAGS }
  );

  const map = useApiQuery(
    'livestock:disease-map',
    () => fetchDiseaseMap().then((res) => res.data),
    { fallbackData: FALLBACK_DISEASE_MAP }
  );

  const report = useApiMutation<void, DiseaseFlag>({
    mutationFn: () =>
      reportDiseaseFlag({
        disease: disease.trim(),
        state,
        lga: lga.trim() || undefined,
        suspectedSpecies: species || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.disease-flag.reported',
      label: () => `Disease flag: ${disease.trim()}`,
      method: 'POST',
      path: () => '/livestock-health/disease-flags',
      payload: () => ({ disease: disease.trim(), state, suspectedSpecies: species || undefined })
    },
    onSuccess: () => {
      setDisease('');
      flags.refresh();
    }
  });

  const confirm = useApiMutation<string, DiseaseFlag>({
    mutationFn: (flagId) => confirmDiseaseFlag(flagId).then((res) => res.data),
    onSuccess: () => {
      flags.refresh();
      map.refresh();
    }
  });

  const retract = useApiMutation<string, DiseaseFlag>({
    mutationFn: (flagId) =>
      retractDiseaseFlag(flagId, (retractReason[flagId] ?? '').trim()).then((res) => res.data),
    onSuccess: () => flags.refresh()
  });

  const flagList = (flags.data ?? []).filter((flag) => !statusFilter || flag.status === statusFilter);

  // Accessible disease map: confirmed flags grouped by state.
  const byState = new Map<string, typeof map.data>();
  for (const entry of map.data ?? []) {
    const rows = byState.get(entry.state) ?? [];
    rows.push(entry);
    byState.set(entry.state, rows);
  }

  return (
    <div className="grid grid-2">
      <Card title="Report and triage flags">
        {flags.source === 'fallback' ? <OfflineDataNotice /> : null}
        <div className="form-grid cols-2">
          <Field id="df-disease" label="Disease">
            <TextInput
              id="df-disease"
              value={disease}
              onChange={(event) => setDisease(event.target.value)}
              placeholder="e.g. PPR"
            />
          </Field>
          <Field id="df-state" label="State">
            <Select id="df-state" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="df-lga" label="LGA (optional)">
            <TextInput id="df-lga" value={lga} onChange={(event) => setLga(event.target.value)} />
          </Field>
          <Field id="df-species" label="Suspected species (optional)">
            <Select
              id="df-species"
              value={species}
              onChange={(event) => setSpecies(event.target.value as '' | LivestockSpecies)}
            >
              <option value="">Unknown</option>
              {LIVESTOCK_SPECIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={disease.trim().length < 2 || state.length === 0 || report.status === 'pending'}
            onClick={() => void report.mutate()}
          >
            {report.status === 'pending' ? 'Reporting…' : 'Report flag'}
          </button>
        </div>
        {report.status === 'error' ? <ApiErrorNotice error={report.error} /> : null}

        <div className="cluster" style={{ marginTop: '1rem' }}>
          <Field id="df-filter" label="Filter flags">
            <Select
              id="df-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as '' | DiseaseFlagStatus)}
            >
              <option value="">All statuses</option>
              {DISEASE_FLAG_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ul className="row-list">
          {flagList.map((flag) => (
            <li className="row-item" key={flag.id}>
              <div className="row-main small">
                <strong>{flag.disease}</strong> · {flag.state}
                {flag.lga ? `, ${flag.lga}` : ''}
                {flag.suspectedSpecies ? ` · ${flag.suspectedSpecies}` : ''} · reported by{' '}
                {flag.reporterUserId}
                {flag.retractedReason ? (
                  <span className="muted"> · retracted: {flag.retractedReason}</span>
                ) : null}
              </div>
              <span className="cluster">
                <AutoBadge value={flag.status} />
                {flag.status === 'reported' && CONFIRM_ROLES.includes(role) ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={confirm.status === 'pending'}
                    onClick={() => void confirm.mutate(flag.id)}
                    aria-label={`Confirm ${flag.disease} flag in ${flag.state}`}
                  >
                    Confirm
                  </button>
                ) : null}
                {flag.status === 'reported' &&
                (CONFIRM_ROLES.includes(role) || flag.reporterUserId === userId) ? (
                  <span className="cluster">
                    <Field id={`df-retract-${flag.id}`} label={`Retract reason for ${flag.id}`}>
                      <TextInput
                        id={`df-retract-${flag.id}`}
                        value={retractReason[flag.id] ?? ''}
                        onChange={(event) =>
                          setRetractReason((current) => ({
                            ...current,
                            [flag.id]: event.target.value
                          }))
                        }
                        placeholder="False positive because…"
                      />
                    </Field>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={
                        (retractReason[flag.id] ?? '').trim().length < 3 ||
                        retract.status === 'pending'
                      }
                      onClick={() => void retract.mutate(flag.id)}
                      aria-label={`Retract ${flag.disease} flag in ${flag.state}`}
                    >
                      Retract
                    </button>
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="State disease map (confirmed)">
        {map.source === 'fallback' ? <OfflineDataNotice /> : null}
        <QueryState
          isLoading={map.isLoading}
          error={map.source === 'fallback' ? undefined : map.error}
          data={map.data}
          onRetry={map.refresh}
          empty={<p className="small muted">No confirmed disease flags yet.</p>}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Disease</th>
                  <th>Confirmed flags</th>
                  <th>Latest report</th>
                </tr>
              </thead>
              <tbody>
                {[...byState.entries()].map(([stateName, rows]) =>
                  (rows ?? []).map((entry, index) => (
                    <tr key={`${stateName}-${entry.disease}`}>
                      {index === 0 ? <th scope="rowgroup" rowSpan={(rows ?? []).length}>{stateName}</th> : null}
                      <td>{entry.disease}</td>
                      <td>{entry.confirmedFlags}</td>
                      <td>{dateLabel(entry.latestReportedAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </QueryState>
      </Card>
    </div>
  );
}

/* --------------------------- reverse a record --------------------------- */

export function ReverseHealthRecordForm() {
  const [recordId, setRecordId] = useState('');
  const [notes, setNotes] = useState('');

  const reverse = useApiMutation<void, AnimalHealthRecord>({
    mutationFn: () => reverseHealthRecord(recordId.trim(), notes.trim() || undefined).then((res) => res.data)
  });

  return (
    <RoleGate roles={VET_ROLES}>
      <div className="cluster">
        <Field id="rev-record" label="Record ID to reverse">
          <TextInput
            id="rev-record"
            value={recordId}
            onChange={(event) => setRecordId(event.target.value)}
            placeholder="hr-1"
          />
        </Field>
        <Field id="rev-notes" label="Reason (optional)">
          <TextInput
            id="rev-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={recordId.trim().length < 2 || reverse.status === 'pending'}
          onClick={() => void reverse.mutate()}
        >
          {reverse.status === 'pending' ? 'Reversing…' : 'Append reversal'}
        </button>
        {reverse.status === 'success' ? <StatusBadge tone="success">reversal appended</StatusBadge> : null}
      </div>
      {reverse.status === 'error' ? <ApiErrorNotice error={reverse.error} /> : null}
    </RoleGate>
  );
}

/* ------------------------------ health hub ------------------------------ */

import { T } from '@/lib/i18n';
import { Section } from '@/components/ui';

/** /livestock/health — vet-signed ledger, movement traceability, recalls, surveillance. */
export function LivestockHealthHub() {
  const [ledgerKey, setLedgerKey] = useState(0);

  return (
    <>
      <Section kicker={<T k="livestock.recordKicker" />} title={<T k="livestock.recordTitle" />}>
        <div className="grid grid-2">
          <RecordHealthForm onRecorded={() => setLedgerKey((key) => key + 1)} />
          <Card title="Reverse a record">
            <p className="small muted">
              The ledger is append-only: corrections are new entries that annul the original, which
              is never edited or deleted.
            </p>
            <ReverseHealthRecordForm />
          </Card>
        </div>
      </Section>

      <Section
        kicker={<T k="livestock.ledgerKicker" />}
        title={<T k="livestock.ledgerTitle" />}
        key={ledgerKey}
      >
        <HealthLedgerBrowser />
      </Section>

      <Section kicker={<T k="livestock.movementKicker" />} title={<T k="livestock.movementTitle" />}>
        <div className="grid grid-2">
          <MovementPanel />
          <PermitPanel />
        </div>
      </Section>

      <Section kicker={<T k="livestock.recallKicker" />} title={<T k="livestock.recallTitle" />}>
        <RecallConsole />
      </Section>

      <Section
        kicker={<T k="livestock.surveillanceKicker" />}
        title={<T k="livestock.surveillanceTitle" />}
      >
        <DiseaseSurveillanceBoard />
      </Section>
    </>
  );
}
