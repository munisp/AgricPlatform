'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { invalidateApiQueries, useApiQuery } from '@/lib/api/hooks';
import {
  cancelPassportTransfer,
  confirmPassportTransfer,
  fetchLivestockPassportEvents,
  fetchMyLivestockPassports,
  fetchPassportTransfers,
  initiatePassportTransfer,
  issueLivestockPassport,
  verifyLivestockPassport,
  type PassportDocument,
  type PassportEvent,
  type PassportChainVerification,
  type PassportTransfer,
  type PublicPassportVerification
} from '@/lib/api/endpoints';
import { Field, TextInput } from '@/components/forms';
import { Card, EmptyState, Section, StatusBadge } from '@/components/ui';
import { ApiErrorNotice, QueryState, SkeletonBlock } from '@/components/api-state';

/**
 * Digital livestock passport console (wave-livestock-passport): my passports
 * with the hash-chained event log, the seller→buyer transfer handshake and
 * the public code verification form. Strings are en-only under
 * `livestockPassport.*` (marked block in dictionaries/en.ts). The tag
 * registry check is STUB-labelled wherever it appears — no government
 * integration is claimed.
 */

/** Short hash badge — first 12 hex chars, full hash in the title tooltip. */
export function HashBadge({ hash, label }: { hash: string; label: string }) {
  return (
    <code className="hash-badge" title={hash} aria-label={`${label}: ${hash.slice(0, 12)}…`}>
      {hash.slice(0, 12)}…
    </code>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* ------------------------------ issue form ------------------------------ */

export function IssuePassportForm({ onIssued }: { onIssued: () => void }) {
  const { t } = useT();
  const [animalId, setAnimalId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await issueLivestockPassport(animalId.trim());
      setNotice(t('livestockPassport.issueSuccess'));
      setAnimalId('');
      onIssued();
    } catch (cause) {
      setError(errorMessage(cause) || t('livestockPassport.issueError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-label={t('livestockPassport.issueTitle')} onSubmit={submit}>
      {error ? <ApiErrorNotice error={error} /> : null}
      {notice ? (
        <p className="notice notice-success" role="status">
          {notice}
        </p>
      ) : null}
      <Field id="passport-animal-id" label={t('livestockPassport.animalIdLabel')}>
        <TextInput
          id="passport-animal-id"
          value={animalId}
          onChange={(e) => setAnimalId(e.target.value)}
          placeholder="NG-BOV-KD-000123"
          required
        />
      </Field>
      <button className="btn btn-primary" type="submit" disabled={pending || !animalId.trim()}>
        {pending ? t('livestockPassport.issueWorking') : t('livestockPassport.issueAction')}
      </button>
    </form>
  );
}

/* ------------------------------ event chain ----------------------------- */

export function PassportEventChain({ passportId }: { passportId: string }) {
  const { t } = useT();
  const [events, setEvents] = useState<PassportEvent[] | null>(null);
  const [verification, setVerification] = useState<PassportChainVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLivestockPassportEvents(passportId);
      setEvents(res.data.events);
      setVerification(res.data.verification);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [passportId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid={`passport-events-${passportId}`}>
      {error ? <ApiErrorNotice error={error} /> : null}
      {!events ? (
        <SkeletonBlock lines={2} />
      ) : (
        <>
          <p className="small muted" role="status" data-testid="chain-status">
            {verification?.valid
              ? t('livestockPassport.chainValid')
              : t('livestockPassport.chainInvalid')}
          </p>
          {events.length === 0 ? (
            <EmptyState title={t('livestockPassport.eventsEmpty')} />
          ) : (
            <ol className="custody-timeline" aria-label={t('livestockPassport.eventsTitle')}>
              {events.map((event) => {
                const check = verification?.events.find((entry) => entry.eventId === event.id);
                return (
                  <li key={event.id} className="custody-event">
                    <StatusBadge tone={check?.valid ? 'success' : 'critical'}>
                      {check?.valid ? '✓' : '✗'}
                    </StatusBadge>{' '}
                    <strong>{event.type}</strong>{' '}
                    <span className="small muted">
                      {new Date(event.createdAt).toLocaleDateString()} · seq {event.seq}
                    </span>{' '}
                    <HashBadge hash={event.eventHash} label={t('livestockPassport.hashLabel')} />
                  </li>
                );
              })}
            </ol>
          )}
          <button
            className="btn btn-ghost btn-small"
            type="button"
            onClick={load}
            disabled={loading}
          >
            {t('livestockPassport.verifyChain')}
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------- transfer initiate -------------------------- */

export function InitiateTransferForm({
  passportId,
  onInitiated
}: {
  passportId: string;
  onInitiated: () => void;
}) {
  const { t } = useT();
  const [buyerId, setBuyerId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await initiatePassportTransfer(passportId, {
        toUserId: buyerId.trim(),
        note: note.trim() || undefined
      });
      setNotice(t('livestockPassport.transferInitiated'));
      setBuyerId('');
      setNote('');
      onInitiated();
    } catch (cause) {
      setError(errorMessage(cause) || t('livestockPassport.transferError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-label={t('livestockPassport.transferTitle')} onSubmit={submit}>
      {error ? <ApiErrorNotice error={error} /> : null}
      {notice ? (
        <p className="notice notice-success" role="status">
          {notice}
        </p>
      ) : null}
      <Field id={`buyer-id-${passportId}`} label={t('livestockPassport.buyerIdLabel')}>
        <TextInput
          id={`buyer-id-${passportId}`}
          value={buyerId}
          onChange={(e) => setBuyerId(e.target.value)}
          required
        />
      </Field>
      <Field id={`note-${passportId}`} label={t('livestockPassport.noteLabel')}>
        <TextInput id={`note-${passportId}`} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <button className="btn btn-secondary btn-small" type="submit" disabled={pending || !buyerId.trim()}>
        {t('livestockPassport.initiateAction')}
      </button>
    </form>
  );
}

/* ------------------------------ passport card ---------------------------- */

export function PassportCard({ document: doc }: { document: PassportDocument }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const coveragePct = Math.round(doc.vaccinationSummary.coverage * 100);
  return (
    <Card title={doc.animal.id}>
      <p className="small">
        {t('livestockPassport.speciesLabel')}: {doc.animal.species} ·{' '}
        {t('livestockPassport.breedLabel')}: {doc.animal.breed} ·{' '}
        <StatusBadge tone={doc.passport.status === 'active' ? 'success' : 'warning'}>
          {doc.passport.status}
        </StatusBadge>
      </p>
      <p className="small muted">
        {t('livestockPassport.codeLabel')}: <code>{doc.passport.passportCode}</code>
      </p>
      <p className="small">
        {t('livestockPassport.coverageLabel')}: {coveragePct}% ·{' '}
        {doc.movementSummary.legal
          ? t('livestockPassport.movementsLegal')
          : t('livestockPassport.movementsIllegal')}{' '}
        ·{' '}
        <StatusBadge tone={doc.chain.valid ? 'success' : 'critical'}>
          {doc.chain.valid ? '✓ chain' : '✗ chain'}
        </StatusBadge>
      </p>
      <p className="small muted">
        {t('livestockPassport.tagBasisLabel')}:{' '}
        {doc.passport.tagCheckBasis === 'stub'
          ? t('livestockPassport.tagBasisStub')
          : doc.passport.tagCheckBasis}
      </p>
      <button
        className="btn btn-ghost btn-small"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {t('livestockPassport.eventsAction')}
      </button>
      {open ? <PassportEventChain passportId={doc.passport.id} /> : null}
      <details className="transfer-panel">
        <summary className="small">{t('livestockPassport.transferTitle')}</summary>
        <p className="small muted">{t('livestockPassport.transferDesc')}</p>
        <InitiateTransferForm
          passportId={doc.passport.id}
          onInitiated={() => invalidateApiQueries('livestockPassport.transfers')}
        />
      </details>
    </Card>
  );
}

/* ------------------------------ transfers -------------------------------- */

export function TransferInbox() {
  const { t } = useT();
  const incoming = useApiQuery<PassportTransfer[]>('livestockPassport.transfers.incoming', () =>
    fetchPassportTransfers('incoming').then((res) => res.data)
  );
  const outgoing = useApiQuery<PassportTransfer[]>('livestockPassport.transfers.outgoing', () =>
    fetchPassportTransfers('outgoing').then((res) => res.data)
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(action: 'confirm' | 'cancel', transferId: string) {
    setError(null);
    setNotice(null);
    try {
      if (action === 'confirm') {
        await confirmPassportTransfer(transferId);
        setNotice(t('livestockPassport.confirmedNotice'));
      } else {
        await cancelPassportTransfer(transferId);
        setNotice(t('livestockPassport.cancelledNotice'));
      }
      invalidateApiQueries(
        'livestockPassport.transfers.incoming',
        'livestockPassport.transfers.outgoing',
        'livestockPassport.mine'
      );
      incoming.refresh();
      outgoing.refresh();
    } catch (cause) {
      setError(errorMessage(cause) || t('livestockPassport.transferFailed'));
    }
  }

  function rows(
    transfers: PassportTransfer[],
    direction: 'incoming' | 'outgoing'
  ): React.ReactNode {
    const pending = transfers.filter((transfer) => transfer.status === 'pending');
    const all = pending.length > 0 ? pending : transfers;
    return (
      <ul className="lot-list">
        {all.map((transfer) => (
          <li key={transfer.id} data-testid={`transfer-${transfer.id}`}>
            <strong>{transfer.animalId}</strong>{' '}
            <StatusBadge tone={transfer.status === 'pending' ? 'info' : 'neutral'}>
              {transfer.status}
            </StatusBadge>{' '}
            <span className="small muted">
              {transfer.fromUserId} → {transfer.toUserId}
            </span>{' '}
            {transfer.status === 'pending' && direction === 'incoming' ? (
              <button
                className="btn btn-primary btn-small"
                type="button"
                onClick={() => void act('confirm', transfer.id)}
              >
                {t('livestockPassport.confirmAction')}
              </button>
            ) : null}{' '}
            {transfer.status === 'pending' && direction === 'outgoing' ? (
              <button
                className="btn btn-ghost btn-small"
                type="button"
                onClick={() => void act('cancel', transfer.id)}
              >
                {t('livestockPassport.cancelAction')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Section title={t('livestockPassport.transferKicker')} description={t('livestockPassport.transferDesc')}>
      {error ? <ApiErrorNotice error={error} /> : null}
      {notice ? (
        <p className="notice notice-success" role="status">
          {notice}
        </p>
      ) : null}
      <h3 className="small">{t('livestockPassport.incomingTitle')}</h3>
      <QueryState
        isLoading={incoming.isLoading}
        error={incoming.error}
        data={incoming.data}
        onRetry={incoming.refresh}
        empty={<EmptyState title={t('livestockPassport.incomingEmpty')} />}
      >
        {rows(incoming.data ?? [], 'incoming')}
      </QueryState>
      <h3 className="small">{t('livestockPassport.outgoingTitle')}</h3>
      <QueryState
        isLoading={outgoing.isLoading}
        error={outgoing.error}
        data={outgoing.data}
        onRetry={outgoing.refresh}
        empty={<EmptyState title={t('livestockPassport.outgoingEmpty')} />}
      >
        {rows(outgoing.data ?? [], 'outgoing')}
      </QueryState>
    </Section>
  );
}

/* --------------------------- public verification ------------------------- */

export function VerifyPassportForm() {
  const { t } = useT();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<PublicPassportVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await verifyLivestockPassport(code.trim());
      setResult(res.data);
    } catch {
      setError(t('livestockPassport.verifyNotFound'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <form aria-label={t('livestockPassport.verifyTitle')} onSubmit={submit}>
        <Field id="verify-passport-code" label={t('livestockPassport.verifyCodeLabel')}>
          <TextInput
            id="verify-passport-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="LSP.NG-BOV-KD-000123.…"
            required
          />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={pending || !code.trim()}>
          {pending ? t('livestockPassport.verifying') : t('livestockPassport.verifyAction')}
        </button>
      </form>
      {error ? (
        <p className="notice notice-critical" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <div data-testid="verify-result">
        <Card title={t('livestockPassport.verifyResultTitle')}>
          <p className="small">
            <strong>{result.animal.id}</strong> — {result.animal.species} · {result.animal.breed} ·{' '}
            {result.animal.sex} ·{' '}
            <StatusBadge tone={result.passportStatus === 'active' ? 'success' : 'warning'}>
              {result.passportStatus}
            </StatusBadge>
          </p>
          <p className="small">
            {t('livestockPassport.ownerLabel')}: <strong>{result.ownerInitials}</strong>
          </p>
          <p className="small">
            {t('livestockPassport.vaccinationsLabel')}:{' '}
            {result.vaccinationSummary.completedVaccinations.length}/
            {result.vaccinationSummary.requiredVaccinations.length}
            {result.vaccinationSummary.completedVaccinations.length > 0
              ? ` (${result.vaccinationSummary.completedVaccinations.join(', ')})`
              : ''}
            {result.vaccinationSummary.activeWithdrawal
              ? ` · ${t('livestockPassport.withdrawalFlag')}`
              : ''}
          </p>
          <p className="small">
            {t('livestockPassport.movementLegalityLabel')}:{' '}
            {result.movementLegality.legal
              ? t('livestockPassport.legalYes')
              : t('livestockPassport.legalNo')}{' '}
            ({result.movementLegality.movementsWithPermit}/{result.movementLegality.totalMovements})
          </p>
          <p className="small">
            {t('livestockPassport.encumbranceLabel')}:{' '}
            {result.encumbrance.activeLien
              ? t('livestockPassport.lienFlag')
              : t('livestockPassport.noLienFlag')}{' '}
            ·{' '}
            {result.encumbrance.insured
              ? t('livestockPassport.insuredFlag')
              : t('livestockPassport.notInsuredFlag')}
          </p>
          <p className="small">
            <StatusBadge tone={result.chain.valid ? 'success' : 'critical'}>
              {result.chain.valid
                ? t('livestockPassport.chainValid')
                : t('livestockPassport.chainInvalid')}
            </StatusBadge>{' '}
            {result.chain.headHash ? (
              <HashBadge hash={result.chain.headHash} label={t('livestockPassport.hashLabel')} />
            ) : null}
          </p>
          <p className="small muted">
            {t('livestockPassport.qrLabel')}: <code>{result.qr.verifyPath}</code>
          </p>
          <ul className="small muted">
            {result.disclaimers.map((disclaimer) => (
              <li key={disclaimer}>{disclaimer}</li>
            ))}
          </ul>
        </Card>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------- hub ----------------------------------- */

export function LivestockPassportHub() {
  const { t } = useT();
  const query = useApiQuery<PassportDocument[]>('livestockPassport.mine', () =>
    fetchMyLivestockPassports().then((res) => res.data)
  );
  return (
    <div>
      <Section title={t('livestockPassport.myPassportsTitle')} description={t('livestockPassport.myPassportsDesc')}>
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          data={query.data}
          onRetry={query.refresh}
          empty={
            <EmptyState
              title={t('livestockPassport.noPassports')}
              hint={t('livestockPassport.noPassportsHint')}
            />
          }
        >
          <ul className="lot-list">
            {(query.data ?? []).map((doc) => (
              <li key={doc.passport.id}>
                <PassportCard document={doc} />
              </li>
            ))}
          </ul>
        </QueryState>
      </Section>
      <Section title={t('livestockPassport.issueTitle')} description={t('livestockPassport.issueDesc')}>
        <IssuePassportForm
          onIssued={() => {
            invalidateApiQueries('livestockPassport.mine');
            query.refresh();
          }}
        />
      </Section>
      <TransferInbox />
      <Section title={t('livestockPassport.verifyTitle')} description={t('livestockPassport.verifyDesc')}>
        <VerifyPassportForm />
      </Section>
    </div>
  );
}
