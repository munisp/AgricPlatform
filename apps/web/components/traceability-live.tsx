'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { invalidateApiQueries, useApiQuery } from '@/lib/api/hooks';
import {
  addCustodyEvent,
  createCommodityLot,
  createTraceabilityShipment,
  fetchLotTimeline,
  fetchShipmentDds,
  listCommodityLots,
  verifyShipmentDds,
  type CommodityLot,
  type CustodyEventType,
  type EudrDds,
  type LotTimeline,
  type ShipmentVerification,
  type TraceabilityShipment
} from '@/lib/api/endpoints';
import { Field, Select, TextInput } from '@/components/forms';
import { Card, EmptyState, Section, StatusBadge } from '@/components/ui';
import { ApiErrorNotice, SkeletonBlock } from '@/components/api-state';

/**
 * EUDR traceability console (wave-eudr): lot list + custody timeline with
 * hash badges and per-event verification, shipment builder and DDS JSON
 * export. Strings are en-only under `traceability.*` (marked block in
 * dictionaries/en.ts).
 */

const CUSTODY_TYPES: CustodyEventType[] = [
  'CREATED',
  'AGGREGATED',
  'SPLIT',
  'TRANSFORMED',
  'SHIPPED',
  'RECEIVED'
];

/** Short hash badge — first 12 hex chars, full hash in the title tooltip. */
export function HashBadge({ hash, label }: { hash: string; label: string }) {
  return (
    <code className="hash-badge" title={hash} aria-label={`${label}: ${hash.slice(0, 12)}…`}>
      {hash.slice(0, 12)}…
    </code>
  );
}

/* ------------------------------ create lot ----------------------------- */

export function LotForm({ onCreated }: { onCreated: (lot: CommodityLot) => void }) {
  const { t } = useT();
  const [crop, setCrop] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('kg');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await createCommodityLot({
        crop,
        quantity: Number(quantity),
        unit,
        harvestWindowStart: new Date(start).toISOString(),
        harvestWindowEnd: new Date(end).toISOString()
      });
      onCreated(res.data);
      setCrop('');
      setQuantity('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-label={t('traceability.createLot')} onSubmit={submit}>
      {error ? (
        <p className="notice notice-critical" role="alert">
          {error}
        </p>
      ) : null}
      <Field id="lot-crop" label={t('traceability.cropLabel')}>
        <TextInput id="lot-crop" value={crop} onChange={(e) => setCrop(e.target.value)} required />
      </Field>
      <Field id="lot-quantity" label={t('traceability.quantityLabel')}>
        <TextInput
          id="lot-quantity"
          type="number"
          min="0"
          step="any"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
      </Field>
      <Field id="lot-unit" label={t('traceability.unitLabel')}>
        <TextInput id="lot-unit" value={unit} onChange={(e) => setUnit(e.target.value)} required />
      </Field>
      <Field id="lot-start" label={t('traceability.harvestStartLabel')}>
        <TextInput id="lot-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
      </Field>
      <Field id="lot-end" label={t('traceability.harvestEndLabel')}>
        <TextInput id="lot-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </Field>
      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? t('traceability.working') : t('traceability.createLot')}
      </button>
    </form>
  );
}

/* --------------------------- custody timeline -------------------------- */

export function CustodyTimeline({ lotId }: { lotId: string }) {
  const { t } = useT();
  const [timeline, setTimeline] = useState<LotTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [eventType, setEventType] = useState<CustodyEventType>('SHIPPED');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLotTimeline(lotId);
      setTimeline(res.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [lotId]);

  // Opening the panel loads (and verifies) the timeline immediately.
  useEffect(() => {
    void load();
  }, [load]);

  async function recordEvent(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await addCustodyEvent(lotId, {
        type: eventType,
        occurredAt: new Date().toISOString(),
        // The console records events at the lot's registered location by
        // default; precise GPS capture lives in the mobile app.
        latitude: 0,
        longitude: 0,
        note: note || undefined
      });
      setNote('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!timeline) {
    return (
      <div>
        {error ? <ApiErrorNotice error={error} /> : null}
        <button className="btn btn-secondary btn-small" type="button" onClick={load} disabled={loading}>
          {loading ? t('traceability.working') : t('traceability.loadTimeline')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid={`timeline-${lotId}`}>
      {error ? <ApiErrorNotice error={error} /> : null}
      <p className="small muted" role="status">
        {timeline.verification.valid
          ? t('traceability.chainValid')
          : t('traceability.chainInvalid')}
      </p>
      <ol className="custody-timeline" aria-label={t('traceability.timelineLabel')}>
        {timeline.events.map((event) => {
          const check = timeline.verification.events.find((entry) => entry.eventId === event.id);
          return (
            <li key={event.id} className="custody-event">
              <StatusBadge tone={check?.valid ? 'success' : 'critical'}>
                {check?.valid ? '✓' : '✗'}
              </StatusBadge>{' '}
              <strong>{event.type}</strong>{' '}
              <span className="small muted">
                {new Date(event.occurredAt).toLocaleDateString()} · seq {event.seq}
              </span>{' '}
              <HashBadge hash={event.eventHash} label={t('traceability.hashLabel')} />
              {event.note ? <span className="small muted"> — {event.note}</span> : null}
            </li>
          );
        })}
      </ol>
      <button className="btn btn-ghost btn-small" type="button" onClick={load} disabled={loading}>
        {t('traceability.verifyChain')}
      </button>
      <form aria-label={t('traceability.recordEvent')} onSubmit={recordEvent}>
        <Field id={`event-type-${lotId}`} label={t('traceability.eventTypeLabel')}>
          <Select
            id={`event-type-${lotId}`}
            value={eventType}
            onChange={(e) => setEventType(e.target.value as CustodyEventType)}
          >
            {CUSTODY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`event-note-${lotId}`} label={t('traceability.noteLabel')}>
          <TextInput
            id={`event-note-${lotId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <button className="btn btn-secondary btn-small" type="submit">
          {t('traceability.recordEvent')}
        </button>
      </form>
    </div>
  );
}

/* ---------------------------- shipment builder ------------------------- */

export function ShipmentBuilder({ lots }: { lots: CommodityLot[] }) {
  const { t } = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shipment, setShipment] = useState<TraceabilityShipment | null>(null);
  const [dds, setDds] = useState<EudrDds | null>(null);
  const [verification, setVerification] = useState<ShipmentVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toggle(lotId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(lotId)) {
        next.delete(lotId);
      } else {
        next.add(lotId);
      }
      return next;
    });
  }

  async function build() {
    setPending(true);
    setError(null);
    setDds(null);
    setVerification(null);
    try {
      const res = await createTraceabilityShipment({ lotIds: [...selected] });
      setShipment(res.data.shipment);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function exportDds() {
    if (!shipment) return;
    setError(null);
    try {
      const res = await fetchShipmentDds(shipment.id);
      setDds(res.data);
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `dds-${shipment.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function verify() {
    if (!shipment) return;
    setError(null);
    try {
      const res = await verifyShipmentDds(shipment.id);
      setVerification(res.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Card title={t('traceability.shipmentBuilder')}>
      {error ? <ApiErrorNotice error={error} /> : null}
      <fieldset className="lot-picker">
        <legend className="small muted">{t('traceability.pickLots')}</legend>
        {lots.map((lot) => (
          <label key={lot.id} className="check-row">
            <input
              type="checkbox"
              checked={selected.has(lot.id)}
              onChange={() => toggle(lot.id)}
            />{' '}
            {lot.crop} — {lot.quantity} {lot.unit}
          </label>
        ))}
      </fieldset>
      <button
        className="btn btn-primary"
        type="button"
        onClick={build}
        disabled={pending || selected.size === 0}
      >
        {pending ? t('traceability.working') : t('traceability.createShipment')}
      </button>
      {shipment ? (
        <div data-testid="shipment-panel">
          <p className="small">
            {t('traceability.shipmentReady')}{' '}
            <HashBadge hash={shipment.id} label={t('traceability.shipmentLabel')} />
          </p>
          <button className="btn btn-secondary btn-small" type="button" onClick={exportDds}>
            {t('traceability.downloadDds')}
          </button>{' '}
          <button className="btn btn-ghost btn-small" type="button" onClick={verify}>
            {t('traceability.verifyShipment')}
          </button>
          {dds ? (
          <p className="small muted" role="status" data-testid="dds-status">
              {t('traceability.ddsExported')} · {t('traceability.riskBasis')}:{' '}
              {dds.deforestationRisk.basis} · {t('traceability.operatorPlaceholder')}
            </p>
          ) : null}
          {verification ? (
            <p
              className={verification.allValid ? 'small' : 'notice notice-critical'}
              role="status"
              data-testid="verify-status"
            >
              {verification.allValid
                ? t('traceability.chainValid')
                : t('traceability.chainInvalid')}{' '}
              · {verification.eventCount} {t('traceability.eventsLabel')}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/* --------------------------------- hub --------------------------------- */

export function TraceabilityHub() {
  const { t } = useT();
  const lots = useApiQuery<CommodityLot[]>('traceability.lots', () =>
    listCommodityLots().then((res) => res.data)
  );
  const [openLotId, setOpenLotId] = useState<string | null>(null);

  if (!lots.data) {
    return (
      <div>
        {lots.error ? <ApiErrorNotice error={lots.error} /> : null}
        <SkeletonBlock lines={4} />
      </div>
    );
  }

  return (
    <div>
      <Section title={t('traceability.lotsTitle')} description={t('traceability.lotsDesc')}>
        {lots.data.length === 0 ? (
          <EmptyState title={t('traceability.noLots')} hint={t('traceability.noLotsHint')} />
        ) : (
          <ul className="lot-list">
            {lots.data.map((lot) => (
              <li key={lot.id}>
                <strong>{lot.crop}</strong> — {lot.quantity} {lot.unit} ·{' '}
                <StatusBadge tone="info">{lot.status}</StatusBadge>{' '}
                <button
                  className="btn btn-ghost btn-small"
                  type="button"
                  onClick={() => setOpenLotId(openLotId === lot.id ? null : lot.id)}
                  aria-expanded={openLotId === lot.id}
                >
                  {t('traceability.viewTimeline')}
                </button>
                {openLotId === lot.id ? <CustodyTimeline lotId={lot.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t('traceability.createLot')} description={t('traceability.createLotDesc')}>
        <LotForm
          onCreated={() => {
            invalidateApiQueries('traceability.lots');
            lots.refresh();
          }}
        />
      </Section>
      {lots.data.length > 0 ? <ShipmentBuilder lots={lots.data} /> : null}
    </div>
  );
}
