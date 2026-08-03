'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EQUIPMENT_TYPES } from '@agric-platform/shared';
import type {
  EquipmentBooking,
  EquipmentListing,
  EquipmentType,
  MechBookingStatus
} from '@agric-platform/shared';
import { useT } from '@/lib/i18n';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  cancelEquipmentBooking,
  completeEquipmentBooking,
  confirmEquipmentBooking,
  fetchEquipmentBooking,
  fetchEquipmentListing,
  fetchOwnerUtilization,
  listEquipmentListings,
  listMyEquipmentBookings,
  listMyEquipmentListings,
  listOwnerEquipmentBookings,
  quoteEquipmentBooking,
  rateEquipmentBooking,
  requestEquipmentBooking,
  setEquipmentListingStatus,
  startEquipmentService
} from '@/lib/api/endpoints';
import { Field, Select, TextInput } from '@/components/forms';
import { QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, formatKobo, StatusBadge, Timeline } from '@/components/ui';

/** Canonical booking pipeline for the status timeline. */
const BOOKING_FLOW: MechBookingStatus[] = [
  'requested',
  'quoted',
  'confirmed',
  'in_service',
  'completed',
  'rated'
];

export function bookingTimeline(booking: EquipmentBooking) {
  const terminal = booking.status === 'cancelled' || booking.status === 'disputed';
  const currentIndex = BOOKING_FLOW.indexOf(booking.status);
  const items = BOOKING_FLOW.slice(0, Math.max(currentIndex + 1, 1)).map((status, index) => ({
    id: status,
    title: status.replace(/_/g, ' '),
    tone: (index === currentIndex && !terminal ? 'warning' : 'default') as 'warning' | 'default'
  }));
  if (terminal) {
    items.push({ id: booking.status, title: booking.status, tone: 'default' });
  }
  return items;
}

function typeLabel(type: string): string {
  return type.replace(/_/g, ' ');
}

/* ------------------------------ browse -------------------------------- */

export function EquipmentBrowser() {
  const { t } = useT();
  const [type, setType] = useState<'' | EquipmentType>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useApiQuery(
    `mech-listings:${type}:${from}:${to}`,
    () =>
      listEquipmentListings({
        type: type || undefined,
        availableFrom: from ? new Date(from).toISOString() : undefined,
        availableTo: to ? new Date(`${to}T23:59:59`).toISOString() : undefined
      }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">{t('mechanization.browseTitle')}</legend>
        <Field id="mech-type" label={t('mechanization.filterType')}>
          <Select
            id="mech-type"
            value={type}
            onChange={(e) => setType(e.target.value as '' | EquipmentType)}
          >
            <option value="">{t('mechanization.filterAllTypes')}</option>
            {EQUIPMENT_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {typeLabel(entry)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="mech-from" label={t('mechanization.filterFrom')}>
          <TextInput id="mech-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field id="mech-to" label={t('mechanization.filterTo')}>
          <TextInput id="mech-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </fieldset>
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title={t('mechanization.browseEmpty')} />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((listing) => (
            <Card key={listing.id} title={listing.title}>
              <p className="small muted">
                {typeLabel(listing.type)} · {listing.ownerType}
              </p>
              <p className="small">
                {listing.rates.perHaNaira
                  ? `₦${listing.rates.perHaNaira.toLocaleString()} ${t('mechanization.perHa')}`
                  : null}
                {listing.rates.perHaNaira && listing.rates.perHourNaira ? ' · ' : null}
                {listing.rates.perHourNaira
                  ? `₦${listing.rates.perHourNaira.toLocaleString()} ${t('mechanization.perHour')}`
                  : null}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <AutoBadge value={listing.operatorVerification} />
                <Link className="btn btn-ghost btn-small" href={`/mechanization/listings/${listing.id}`}>
                  {t('mechanization.listingDetail')}
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* --------------------------- listing detail ---------------------------- */

export function EquipmentListingDetail({ listingId }: { listingId: string }) {
  const { t } = useT();
  const query = useApiQuery(
    `mech-listing:${listingId}`,
    () => fetchEquipmentListing(listingId).then((res) => res.data)
  );

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title={t('mechanization.browseEmpty')} />}
    >
      {query.data ? (
        <div className="stack">
          <Card title={query.data.title}>
            <p className="small muted">
              {typeLabel(query.data.type)} · {query.data.ownerType}
            </p>
            <OperatorBadge listing={query.data} />
            <h3>{t('mechanization.ratesTitle')}</h3>
            <ul className="small">
              {query.data.rates.perHaNaira ? (
                <li>
                  ₦{query.data.rates.perHaNaira.toLocaleString()} {t('mechanization.perHa')}
                </li>
              ) : null}
              {query.data.rates.perHourNaira ? (
                <li>
                  ₦{query.data.rates.perHourNaira.toLocaleString()} {t('mechanization.perHour')}
                </li>
              ) : null}
              <li>
                ₦{query.data.rates.perKmNaira.toLocaleString()}{' '}
                {t('mechanization.perKm', { km: query.data.rates.includedKm })}
              </li>
            </ul>
            <h3>{t('mechanization.serviceArea')}</h3>
            <p className="small">
              {t('mechanization.serviceAreaSummary', {
                cells: query.data.serviceAreaH3.length,
                res: query.data.serviceAreaResolution
              })}
            </p>
            {Object.keys(query.data.specs).length > 0 ? (
              <>
                <h3>{t('mechanization.specsTitle')}</h3>
                <ul className="small">
                  {Object.entries(query.data.specs).map(([key, value]) => (
                    <li key={key}>
                      {key}: {String(value)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="small muted">{t('mechanization.holdNote')}</p>
          </Card>
          <BookingRequestForm listing={query.data} />
        </div>
      ) : null}
    </QueryState>
  );
}

function OperatorBadge({ listing }: { listing: EquipmentListing }) {
  const { t } = useT();
  const label =
    listing.operatorVerification === 'verified'
      ? t('mechanization.operatorBadge')
      : listing.operatorVerification === 'suspended'
        ? t('mechanization.operatorSuspended')
        : t('mechanization.operatorPending');
  return <StatusBadge tone={listing.operatorVerification === 'verified' ? 'success' : 'warning'}>{label}</StatusBadge>;
}

function BookingRequestForm({ listing }: { listing: EquipmentListing }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [plotLat, setPlotLat] = useState('');
  const [plotLong, setPlotLong] = useState('');
  const [areaHa, setAreaHa] = useState('1');
  const [hours, setHours] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [booked, setBooked] = useState<EquipmentBooking | null>(null);

  const mutation = useApiMutation<
    {
      plotLat: number;
      plotLong: number;
      areaHa: number;
      estimatedHours?: number;
      windowStart: string;
      windowEnd: string;
    },
    EquipmentBooking
  >({
    mutationFn: (input) => requestEquipmentBooking(listing.id, input).then((res) => res.data),
    onSuccess: (booking) => setBooked(booking)
  });

  const needsHours = Boolean(listing.rates.perHourNaira);
  const valid =
    plotLat.trim() !== '' &&
    plotLong.trim() !== '' &&
    Number(areaHa) > 0 &&
    start !== '' &&
    end !== '' &&
    end > start &&
    (!needsHours || Number(hours) > 0);

  if (booked) {
    return (
      <Card title={t('mechanization.bookingTitle')}>
        <p className="small">
          {t('mechanization.bookingDetail')}: <AutoBadge value={booked.status} />
        </p>
        <Link className="btn btn-primary btn-small" href={`/mechanization/bookings/${booked.id}`}>
          {t('mechanization.bookingDetail')}
        </Link>
      </Card>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
        aria-label={t('mechanization.bookAction')}
      >
        {t('mechanization.bookAction')}
      </button>
    );
  }

  return (
    <Card title={t('mechanization.bookingTitle')}>
      <div className="form-grid cols-2">
        <Field id="bk-lat" label={t('mechanization.plotLat')}>
          <TextInput id="bk-lat" inputMode="decimal" value={plotLat} onChange={(e) => setPlotLat(e.target.value)} />
        </Field>
        <Field id="bk-long" label={t('mechanization.plotLong')}>
          <TextInput id="bk-long" inputMode="decimal" value={plotLong} onChange={(e) => setPlotLong(e.target.value)} />
        </Field>
        <Field id="bk-area" label={t('mechanization.areaHa')}>
          <TextInput id="bk-area" inputMode="decimal" value={areaHa} onChange={(e) => setAreaHa(e.target.value)} />
        </Field>
        {needsHours ? (
          <Field id="bk-hours" label={t('mechanization.estimatedHours')}>
            <TextInput id="bk-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
        ) : null}
        <Field id="bk-start" label={t('mechanization.windowStart')}>
          <TextInput id="bk-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field id="bk-end" label={t('mechanization.windowEnd')}>
          <TextInput id="bk-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      {mutation.error ? <p role="alert" className="small">{String(mutation.error)}</p> : null}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!valid || mutation.status === 'pending'}
        onClick={() =>
          mutation.mutate({
            plotLat: Number(plotLat),
            plotLong: Number(plotLong),
            areaHa: Number(areaHa),
            ...(needsHours ? { estimatedHours: Number(hours) } : {}),
            windowStart: new Date(start).toISOString(),
            windowEnd: new Date(end).toISOString()
          })
        }
      >
        {t('mechanization.bookAction')}
      </button>
    </Card>
  );
}

/* --------------------------- booking detail ---------------------------- */

export function EquipmentBookingDetail({ bookingId }: { bookingId: string }) {
  const { t } = useT();
  const [rating, setRating] = useState('5');
  const query = useApiQuery(
    `mech-booking:${bookingId}`,
    () => fetchEquipmentBooking(bookingId).then((res) => res.data)
  );

  const [pending, setPending] = useState(false);

  const run = (fn: (id: string) => Promise<{ data: EquipmentBooking }>) => {
    setPending(true);
    return fn(bookingId)
      .then(() => query.refresh())
      .finally(() => setPending(false));
  };

  const booking = query.data;
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={booking}
      onRetry={query.refresh}
      empty={<EmptyState title={t('mechanization.myBookingsEmpty')} />}
    >
      {booking ? (
        <div className="stack">
          <Card title={t('mechanization.bookingDetail')}>
            <Timeline items={bookingTimeline(booking)} />
            {booking.advisory?.severe ? (
              <p>
                <StatusBadge tone="critical">
                  {t('mechanization.advisoryBadge', { severity: booking.advisory.severity ?? 'severe' })}
                </StatusBadge>{' '}
                <span className="small muted">
                  {t('mechanization.advisoryBasis', { basis: booking.advisory.basis })}
                </span>
              </p>
            ) : booking.advisory ? (
              <p className="small muted">
                {t('mechanization.advisoryBasis', { basis: booking.advisory.basis })}
              </p>
            ) : null}
            {booking.quote ? (
              <dl className="small">
                <dt>{t('mechanization.quoteBase')}</dt>
                <dd>
                  {formatKobo(booking.quote.areaComponentKobo + booking.quote.hourComponentKobo)}
                </dd>
                <dt>{t('mechanization.quoteDistance')}</dt>
                <dd>{formatKobo(booking.quote.distanceSurchargeKobo)}</dd>
                <dt>{t('mechanization.quoteSeasonal')}</dt>
                <dd>×{booking.quote.seasonalMultiplier}</dd>
                <dt>{t('mechanization.quoteTotal')}</dt>
                <dd>{formatKobo(booking.quote.totalKobo)}</dd>
              </dl>
            ) : null}
            <p className="small muted">{t('mechanization.holdNote')}</p>
          </Card>
          <div className="cluster">
            {booking.status === 'quoted' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={() => void run(confirmEquipmentBooking)}
              >
                {t('mechanization.confirmAction')}
              </button>
            ) : null}
            {booking.status === 'completed' ? (
              <>
                <Field id="bk-rating" label={t('mechanization.rateAction')}>
                  <Select id="bk-rating" value={rating} onChange={(e) => setRating(e.target.value)}>
                    {['5', '4', '3', '2', '1'].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() =>
                    void rateEquipmentBooking(bookingId, Number(rating)).then(() => query.refresh())
                  }
                >
                  {t('mechanization.rateAction')}
                </button>
              </>
            ) : null}
            {booking.status === 'requested' || booking.status === 'quoted' || booking.status === 'confirmed' ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => void run(cancelEquipmentBooking)}
              >
                {t('mechanization.cancelAction')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </QueryState>
  );
}

/* ----------------------------- my bookings ----------------------------- */

export function MyEquipmentBookings() {
  const { t } = useT();
  const query = useApiQuery(
    'mech-bookings:mine',
    () => listMyEquipmentBookings().then((res) => res.data),
    { fallbackData: [] }
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.source === 'fallback' ? undefined : query.error}
      data={query.data}
      onRetry={query.refresh}
      empty={<EmptyState title={t('mechanization.myBookingsEmpty')} />}
    >
      <div className="grid grid-2">
        {(query.data ?? []).map((booking) => (
          <Card key={booking.id} title={`${booking.areaHa} ha · ${booking.windowStart.slice(0, 10)}`}>
            <AutoBadge value={booking.status} />
            {booking.quote ? <p className="small">{formatKobo(booking.quote.totalKobo)}</p> : null}
            <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
              <Link className="btn btn-ghost btn-small" href={`/mechanization/bookings/${booking.id}`}>
                {t('mechanization.bookingDetail')}
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </QueryState>
  );
}

/* ---------------------------- owner dashboard -------------------------- */

export function OwnerDashboard() {
  const { t } = useT();
  const listings = useApiQuery(
    'mech-listings:mine',
    () => listMyEquipmentListings().then((res) => res.data),
    { fallbackData: [] }
  );
  const queue = useApiQuery(
    'mech-bookings:queue',
    () => listOwnerEquipmentBookings().then((res) => res.data),
    { fallbackData: [] }
  );
  const stats = useApiQuery('mech-owner-stats', () => fetchOwnerUtilization().then((res) => res.data));

  const refreshAll = () => {
    listings.refresh();
    queue.refresh();
    stats.refresh();
  };

  return (
    <div className="stack">
      <h2>{t('mechanization.statsTitle')}</h2>
      <QueryState isLoading={stats.isLoading} error={stats.error} data={stats.data} onRetry={stats.refresh}>
        {stats.data ? (
          <div className="grid grid-4">
            <Card title={t('mechanization.statsListings')}>
              <p>{stats.data.listingCount}</p>
            </Card>
            <Card title={t('mechanization.statsBookedHours')}>
              <p>{stats.data.bookedHours}</p>
            </Card>
            <Card title={t('mechanization.statsRevenue')}>
              <p>{formatKobo(stats.data.revenueClearedKobo)}</p>
            </Card>
            <Card title={t('mechanization.statsCompletion')}>
              <p>{Math.round(stats.data.completionRate * 100)}%</p>
            </Card>
          </div>
        ) : null}
      </QueryState>

      <h2>{t('mechanization.ownerTitle')}</h2>
      <QueryState
        isLoading={listings.isLoading}
        error={listings.source === 'fallback' ? undefined : listings.error}
        data={listings.data}
        onRetry={listings.refresh}
        empty={<EmptyState title={t('mechanization.ownerEmpty')} />}
      >
        <div className="grid grid-3">
          {(listings.data ?? []).map((listing) => (
            <Card key={listing.id} title={listing.title}>
              <div className="cluster">
                <AutoBadge value={listing.status} />
                <AutoBadge value={listing.operatorVerification} />
              </div>
              <div className="cluster" style={{ marginTop: '0.6rem' }}>
                {listing.status === 'draft' || listing.status === 'paused' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() => void setEquipmentListingStatus(listing.id, 'active').then(refreshAll)}
                  >
                    activate
                  </button>
                ) : null}
                {listing.status === 'active' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => void setEquipmentListingStatus(listing.id, 'paused').then(refreshAll)}
                  >
                    pause
                  </button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      </QueryState>

      <h2>{t('mechanization.queueTitle')}</h2>
      <QueryState
        isLoading={queue.isLoading}
        error={queue.source === 'fallback' ? undefined : queue.error}
        data={queue.data}
        onRetry={queue.refresh}
        empty={<EmptyState title={t('mechanization.queueEmpty')} />}
      >
        <div className="grid grid-2">
          {(queue.data ?? []).map((booking) => (
            <Card key={booking.id} title={`${booking.areaHa} ha · ${booking.windowStart.slice(0, 10)}`}>
              <AutoBadge value={booking.status} />
              {booking.quote ? <p className="small">{formatKobo(booking.quote.totalKobo)}</p> : null}
              <div className="cluster" style={{ marginTop: '0.6rem' }}>
                {booking.status === 'requested' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() => void quoteEquipmentBooking(booking.id).then(refreshAll)}
                  >
                    {t('mechanization.quoteAction')}
                  </button>
                ) : null}
                {booking.status === 'confirmed' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() => void startEquipmentService(booking.id).then(refreshAll)}
                  >
                    {t('mechanization.startAction')}
                  </button>
                ) : null}
                {booking.status === 'in_service' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() => void completeEquipmentBooking(booking.id).then(refreshAll)}
                  >
                    {t('mechanization.completeAction')}
                  </button>
                ) : null}
                <Link className="btn btn-ghost btn-small" href={`/mechanization/bookings/${booking.id}`}>
                  {t('mechanization.bookingDetail')}
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
    </div>
  );
}
