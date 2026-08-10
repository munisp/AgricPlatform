'use client';

import { useState } from 'react';
import Link from 'next/link';
import { OWNERSHIP_TRANSFER_TYPES } from '@agric-platform/shared';
import type { Animal, OwnershipTransferType } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  fetchAnimal,
  fetchAnimalGrade,
  listAnimalTransfers,
  listLiens,
  transferAnimal
} from '@/lib/api/endpoints';
import { demoAnimalGrade, demoAnimals, demoLiens, demoTransfers } from '@/lib/content';
import { Field, Select, TextInput } from '@/components/forms';
import { AutoBadge, Card, StatusBadge, Timeline, formatKobo } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

/* ------------------------------- grade -------------------------------- */

const GRADE_TONES: Record<string, 'success' | 'info' | 'warning' | 'critical'> = {
  A: 'success',
  B: 'info',
  C: 'warning',
  D: 'critical'
};

/** Trust grade (A–D) with the deterministic rubric exposed as a tooltip. */
export function AnimalGradeBadge({ animalId }: { animalId: string }) {
  const query = useApiQuery(
    `livestock:grade:${animalId}`,
    () => fetchAnimalGrade(animalId).then((res) => res.data),
    // Offline fallback only — live grade from GET /api/v1/livestock-health/animals/:id/grade.
    { fallbackData: demoAnimalGrade }
  );
  const grade = query.data;
  // Never present fixture grades as real: on fallback the grade is unknown.
  if (query.source === 'fallback') {
    return (
      <StatusBadge tone="neutral" ariaLabel="Trust grade unavailable offline">
        Grade unavailable offline
      </StatusBadge>
    );
  }
  if (!grade) return null;

  const rubric =
    `Trust grade rubric (score ${grade.score}/100): ` +
    `vaccination ${grade.components.vaccinationPoints} pts ` +
    `(${grade.components.completedVaccinations.length}/${grade.components.requiredVaccinations.length} of schedule), ` +
    `treatment ${grade.components.treatmentPoints} pts, ` +
    `movement ${grade.components.movementPoints} pts (${grade.components.movementCount} recorded), ` +
    `age ${grade.components.agePoints} pts.`;

  return (
    <span title={rubric}>
      <StatusBadge tone={GRADE_TONES[grade.grade] ?? 'neutral'} ariaLabel={`Trust grade ${grade.grade}. ${rubric}`}>
        Grade {grade.grade}
      </StatusBadge>
    </span>
  );
}

/* ---------------------------- lien warning ----------------------------- */

/** Active liens over this animal — transfer/sale is blocked while any is active. */
export function AnimalLienWarning({ animalId }: { animalId: string }) {
  const query = useApiQuery(
    `livestock:liens:animal:${animalId}`,
    () => listLiens({ subjectType: 'animal', subjectId: animalId }).then((res) => res.data),
    // Offline fallback only — live liens from GET /api/v1/livestock-finance/liens.
    { fallbackData: demoLiens.filter((lien) => lien.subjectId === animalId) }
  );
  const liens = query.data ?? [];
  const active = liens.filter((lien) => lien.status === 'active');

  if (active.length === 0) return null;
  return (
    <div className="notice notice-warning" role="alert" data-testid="lien-warning">
      <strong>Active lien — transfer blocked.</strong>{' '}
      {active.map((lien) => (
        <span key={lien.id}>
          Lien {lien.id} ({formatKobo(lien.principalKobo)}) held by {lien.lenderUserId}: {lien.terms}{' '}
        </span>
      ))}
      This animal cannot be transferred or sold until the lien is discharged.
    </div>
  );
}

/* ----------------------------- transfer flow --------------------------- */

export function TransferOwnershipForm({ animal }: { animal: Animal }) {
  const { userId } = useAppState();
  const [toUserId, setToUserId] = useState('');
  const [transferType, setTransferType] = useState<OwnershipTransferType>('sale');
  const [effectiveAt, setEffectiveAt] = useState('');

  const liensQuery = useApiQuery(
    `livestock:liens:animal:${animal.id}`,
    () => listLiens({ subjectType: 'animal', subjectId: animal.id }).then((res) => res.data),
    { fallbackData: demoLiens }
  );
  // Fixture liens are unverified — never gate a transfer on fabricated data.
  const liensUnverified = liensQuery.source === 'fallback';
  const hasActiveLien =
    !liensUnverified && (liensQuery.data ?? []).some((lien) => lien.status === 'active');

  const transfer = useApiMutation<void, unknown>({
    mutationFn: () =>
      transferAnimal(animal.id, {
        toUserId: toUserId.trim(),
        transferType,
        effectiveAt: effectiveAt || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.animal.transferred',
      label: () => `Transfer ${animal.id}`,
      method: 'POST',
      path: () => `/livestock/animals/${animal.id}/transfer`,
      payload: () => ({ toUserId: toUserId.trim(), transferType })
    }
  });

  if (animal.ownerUserId !== userId) {
    return (
      <p className="small muted">Only the current owner can transfer this animal.</p>
    );
  }
  if (animal.status === 'dead') {
    return <p className="small muted">A dead animal cannot be transferred.</p>;
  }

  return (
    <div>
      {hasActiveLien ? (
        <p className="notice notice-warning" role="alert" data-testid="transfer-lien-block">
          Transfer disabled — this animal has an active lien. The lien must be discharged first.
        </p>
      ) : null}
      {liensUnverified ? (
        <p className="notice notice-warning" role="alert" data-testid="transfer-liens-unverified">
          Transfer disabled — unable to verify liens offline. Reconnect and retry to confirm this
          animal has no active lien.
        </p>
      ) : null}
      <div className="form-grid cols-2">
        <Field id="transfer-to" label="New owner (user ID)">
          <TextInput
            id="transfer-to"
            value={toUserId}
            onChange={(event) => setToUserId(event.target.value)}
            placeholder="e.g. user-hassan"
          />
        </Field>
        <Field id="transfer-type" label="Transfer type">
          <Select
            id="transfer-type"
            value={transferType}
            onChange={(event) => setTransferType(event.target.value as OwnershipTransferType)}
          >
            {OWNERSHIP_TRANSFER_TYPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="transfer-effective" label="Effective date (optional)">
          <TextInput
            id="transfer-effective"
            type="date"
            value={effectiveAt}
            onChange={(event) => setEffectiveAt(event.target.value)}
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
        {transfer.status === 'success' ? <StatusBadge tone="success">transferred</StatusBadge> : null}
        {transfer.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            hasActiveLien ||
            liensUnverified ||
            toUserId.trim().length < 3 ||
            transfer.status === 'pending'
          }
          title={
            hasActiveLien
              ? 'Active lien blocks transfer'
              : liensUnverified
                ? 'Lien status unverified offline'
                : undefined
          }
          onClick={() => void transfer.mutate()}
        >
          {transfer.status === 'pending' ? 'Transferring…' : 'Transfer ownership'}
        </button>
      </div>
      {transfer.status === 'error' ? <ApiErrorNotice error={transfer.error} /> : null}
    </div>
  );
}

/* --------------------------- transfer timeline ------------------------- */

export function OwnershipTimeline({ animalId }: { animalId: string }) {
  const query = useApiQuery(
    `livestock:transfers:${animalId}`,
    () => listAnimalTransfers(animalId).then((res) => res.data),
    // Offline fallback only — live history from GET /api/v1/livestock/animals/:id/transfers.
    { fallbackData: demoTransfers }
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<p className="small muted">No ownership transfers recorded yet.</p>}
      >
        <Timeline
          items={(query.data ?? []).map((transfer) => ({
            id: transfer.id,
            title: `${transfer.fromUserId} → ${transfer.toUserId}`,
            date: new Date(transfer.effectiveAt).toLocaleDateString('en-NG', {
              dateStyle: 'medium'
            }),
            description: `Type: ${transfer.transferType} · recorded by ${transfer.recordedBy}`
          }))}
        />
      </QueryState>
    </>
  );
}

/* ------------------------------ detail page ---------------------------- */

export function AnimalDetail({ animalId }: { animalId: string }) {
  const query = useApiQuery(
    `livestock:animal:${animalId}`,
    () => fetchAnimal(animalId).then((res) => res.data),
    // Offline fallback only — live detail from GET /api/v1/livestock/animals/:id.
    { fallbackData: demoAnimals.find((animal) => animal.id === animalId) ?? demoAnimals[0] }
  );
  const animal = query.data;

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={animal}
        onRetry={query.refresh}
      >
        {animal ? (
          <div className="stack-lg">
            <Card title={animal.id}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <p className="small muted" style={{ margin: 0 }}>
                  {animal.breed} {animal.species} · {animal.sex} · {animal.state}
                  {animal.lga ? `, ${animal.lga}` : ''}
                  {animal.birthDate
                    ? ` · born ${new Date(animal.birthDate).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`
                    : ''}
                </p>
                <span className="cluster">
                  <AutoBadge value={animal.status} />
                  <AnimalGradeBadge animalId={animal.id} />
                </span>
              </div>
              <dl className="detail-list" style={{ marginTop: '0.75rem' }}>
                {animal.tagId ? (
                  <div className="cluster" style={{ justifyContent: 'space-between' }}>
                    <dt className="small muted">Ear tag</dt>
                    <dd className="small">{animal.tagId}</dd>
                  </div>
                ) : null}
                {animal.eid ? (
                  <div className="cluster" style={{ justifyContent: 'space-between' }}>
                    <dt className="small muted">EID</dt>
                    <dd className="small">{animal.eid}</dd>
                  </div>
                ) : null}
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <dt className="small muted">Sire</dt>
                  <dd className="small">
                    {animal.sireId ? (
                      <Link href={`/livestock/animals/${animal.sireId}`}>{animal.sireId}</Link>
                    ) : (
                      'Not recorded'
                    )}
                  </dd>
                </div>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <dt className="small muted">Dam</dt>
                  <dd className="small">
                    {animal.damId ? (
                      <Link href={`/livestock/animals/${animal.damId}`}>{animal.damId}</Link>
                    ) : (
                      'Not recorded'
                    )}
                  </dd>
                </div>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <dt className="small muted">Owner</dt>
                  <dd className="small">{animal.ownerUserId}</dd>
                </div>
              </dl>
              {animal.notes ? <p className="small muted">{animal.notes}</p> : null}
              <AnimalLienWarning animalId={animal.id} />
            </Card>

            <div className="grid grid-2">
              <Card title="Ownership history">
                <OwnershipTimeline animalId={animal.id} />
              </Card>
              <Card title="Transfer ownership">
                <TransferOwnershipForm animal={animal} />
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
