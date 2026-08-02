'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  NIGERIAN_STATES,
  SUPPLIER_CATEGORIES,
  formatNaira
} from '@agric-platform/shared';
import type {
  BookingStatus,
  ServiceBooking,
  ServiceOffering,
  ServiceReview,
  ServiceSupplier,
  SupplierCategory
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  createServiceBooking,
  createServiceReview,
  fetchServiceBooking,
  fetchServiceSupplier,
  listServiceSuppliers,
  listSupplierOfferings,
  listSupplierReviews,
  setServiceBookingStatus
} from '@/lib/api/endpoints';
import { usePersistentState } from '@/lib/use-persistent-state';
import { Field, Select, TextArea, TextInput } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, StatusBadge, Timeline } from '@/components/ui';

/** Booking ids created on this device — the API has no "my bookings" list. */
const MY_BOOKINGS_KEY = 'agric.my-service-bookings';

function categoryLabel(category: string): string {
  return category.replace(/_/g, ' ');
}

/** Canonical booking pipeline for the status timeline. */
const BOOKING_FLOW: BookingStatus[] = ['requested', 'quoted', 'accepted', 'scheduled', 'completed'];

function bookingTimeline(booking: ServiceBooking) {
  const terminal = booking.status === 'declined' || booking.status === 'cancelled';
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

/* ---------------------------- directory ------------------------------- */

export function SupplierDirectory() {
  const [category, setCategory] = useState<'' | SupplierCategory>('');
  const [state, setState] = useState('');

  const query = useApiQuery(
    `service-suppliers:${category}:${state}`,
    () =>
      listServiceSuppliers({
        category: category || undefined,
        state: state || undefined,
        pageSize: 60
      }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">Filter suppliers</legend>
        <Field id="svc-cat" label="Category">
          <Select
            id="svc-cat"
            value={category}
            onChange={(e) => setCategory(e.target.value as '' | SupplierCategory)}
          >
            <option value="">All categories</option>
            {SUPPLIER_CATEGORIES.map((entry) => (
              <option key={entry} value={entry}>
                {categoryLabel(entry)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="svc-state" label="State">
          <Select id="svc-state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {NIGERIAN_STATES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title="No suppliers match" hint="Try a different category or state." />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((supplier) => (
            <Card key={supplier.id} title={supplier.businessName}>
              <p className="small muted">
                {supplier.categories.map(categoryLabel).join(', ')} ·{' '}
                {supplier.statesCovered.join(', ') || 'Nationwide'}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <span aria-label={`Rated ${supplier.averageRating.toFixed(1)} out of 5 from ${supplier.ratingCount} reviews`}>
                  {'★'.repeat(Math.round(supplier.averageRating)) || '☆'}{' '}
                  <span className="small muted">
                    {supplier.averageRating.toFixed(1)} ({supplier.ratingCount})
                  </span>
                </span>
                <AutoBadge value={supplier.verificationStatus} />
              </div>
              <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
                <Link className="btn btn-ghost btn-small" href={`/services/${supplier.id}`}>
                  View supplier
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* --------------------------- supplier detail --------------------------- */

function BookingRequestForm({
  offering,
  supplier,
  onBooked
}: {
  offering: ServiceOffering;
  supplier: ServiceSupplier;
  onBooked: (booking: ServiceBooking) => void;
}) {
  const { userId } = useAppState();
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState('1');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [notes, setNotes] = useState('');

  const mutation = useApiMutation<
    { quantity: number; scheduledStart: string; scheduledEnd: string; notes?: string },
    ServiceBooking
  >({
    mutationFn: (input) =>
      createServiceBooking(offering.id, { customerId: userId, ...input }).then((res) => res.data),
    queue: {
      kind: 'services.booking.created',
      label: () => `Booking: ${offering.title}`,
      method: 'POST',
      path: () => `/service-offerings/${offering.id}/bookings`,
      payload: (input) => ({ customerId: userId, ...input })
    },
    onSuccess: (booking) => onBooked(booking),
    onQueued: () => setOpen(false)
  });

  const valid = Number(quantity) >= 1 && start !== '' && end !== '' && end >= start;

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-primary btn-small"
        onClick={() => setOpen(true)}
        aria-label={`Request booking for ${offering.title} from ${supplier.businessName}`}
      >
        Request booking
      </button>
    );
  }

  return (
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      <div className="form-grid cols-2">
        <Field id={`bk-qty-${offering.id}`} label="Quantity">
          <TextInput
            id={`bk-qty-${offering.id}`}
            value={quantity}
            inputMode="numeric"
            onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </Field>
        <Field id={`bk-start-${offering.id}`} label="Start date">
          <TextInput
            id={`bk-start-${offering.id}`}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field id={`bk-end-${offering.id}`} label="End date">
          <TextInput
            id={`bk-end-${offering.id}`}
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
        <Field id={`bk-notes-${offering.id}`} label="Notes (optional)">
          <TextArea
            id={`bk-notes-${offering.id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={mutation.status === 'pending'}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={!valid || mutation.status === 'pending'}
          onClick={() =>
            void mutation.mutate({
              quantity: Number(quantity),
              scheduledStart: new Date(start).toISOString(),
              scheduledEnd: new Date(end).toISOString(),
              notes: notes.trim() || undefined
            })
          }
        >
          {mutation.status === 'pending' ? 'Sending…' : 'Send request'}
        </button>
      </div>
      {mutation.status === 'queued' ? (
        <StatusBadge tone="warning">booking queued for sync</StatusBadge>
      ) : null}
      {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}
    </div>
  );
}

export function SupplierDetail({ supplierId }: { supplierId: string }) {
  const [, setMyBookings] = usePersistentState<string[]>(MY_BOOKINGS_KEY, []);

  const supplierQuery = useApiQuery(
    `service-supplier:${supplierId}`,
    () => fetchServiceSupplier(supplierId).then((res) => res.data),
    { fallbackData: undefined }
  );
  const offeringsQuery = useApiQuery(
    `service-offerings:${supplierId}`,
    () => listSupplierOfferings(supplierId).then((res) => res.data),
    { fallbackData: [] }
  );
  const reviewsQuery = useApiQuery(
    `service-reviews:${supplierId}`,
    () => listSupplierReviews(supplierId).then((res) => res.data),
    { fallbackData: [] }
  );

  const supplier = supplierQuery.data;

  return (
    <>
      <QueryState
        isLoading={supplierQuery.isLoading}
        error={supplierQuery.error}
        data={supplier}
        onRetry={supplierQuery.refresh}
      >
        {supplier ? (
          <Card title={supplier.businessName}>
            <p className="small muted">
              {supplier.categories.map(categoryLabel).join(', ')} · covers{' '}
              {supplier.statesCovered.join(', ') || 'nationwide'}
            </p>
            <div className="cluster">
              <AutoBadge value={supplier.verificationStatus} />
              <StatusBadge tone="info" ariaLabel={`Average rating ${supplier.averageRating.toFixed(1)} from ${supplier.ratingCount} reviews`}>
                ★ {supplier.averageRating.toFixed(1)} ({supplier.ratingCount} reviews)
              </StatusBadge>
            </div>
          </Card>
        ) : null}
      </QueryState>

      <h3>Offerings</h3>
      <QueryState
        isLoading={offeringsQuery.isLoading}
        error={offeringsQuery.error}
        data={offeringsQuery.data}
        onRetry={offeringsQuery.refresh}
        empty={<EmptyState title="No offerings yet" />}
      >
        <div className="grid grid-2">
          {(offeringsQuery.data ?? [])
            .filter((offering) => offering.isActive)
            .map((offering) => (
              <Card key={offering.id} title={offering.title}>
                <p className="small muted">{offering.description}</p>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700 }}>
                    {formatNaira(offering.priceNaira)}{' '}
                    <span className="small muted">{offering.pricingUnit.replace(/_/g, ' ')}</span>
                  </span>
                  {supplier ? (
                    <BookingRequestForm
                      offering={offering}
                      supplier={supplier}
                      onBooked={(booking) =>
                        setMyBookings((current) => [booking.id, ...current])
                      }
                    />
                  ) : null}
                </div>
              </Card>
            ))}
        </div>
      </QueryState>

      <h3>Reviews</h3>
      <QueryState
        isLoading={reviewsQuery.isLoading}
        error={reviewsQuery.error}
        data={reviewsQuery.data}
        onRetry={reviewsQuery.refresh}
        empty={<EmptyState title="No reviews yet" />}
      >
        <ul className="row-list">
          {(reviewsQuery.data ?? []).map((review) => (
            <li className="row-item" key={review.id}>
              <div className="row-main">
                <div className="row-title" aria-label={`${review.rating} out of 5`}>
                  {'★'.repeat(review.rating)}
                  {'☆'.repeat(5 - review.rating)}
                </div>
                {review.comment ? <div className="small muted">{review.comment}</div> : null}
              </div>
              <span className="small muted">
                {new Date(review.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              </span>
            </li>
          ))}
        </ul>
      </QueryState>
    </>
  );
}

/* ----------------------------- my bookings ----------------------------- */

function ReviewForm({ booking, onReviewed }: { booking: ServiceBooking; onReviewed: (review: ServiceReview) => void }) {
  const { userId } = useAppState();
  const [rating, setRating] = useState('5');
  const [comment, setComment] = useState('');

  const mutation = useApiMutation<{ rating: number; comment?: string }, ServiceReview>({
    mutationFn: (input) =>
      createServiceReview(booking.id, { authorId: userId, ...input }).then((res) => res.data),
    queue: {
      kind: 'services.review.created',
      label: () => `Review for booking ${booking.id}`,
      method: 'POST',
      path: () => `/service-bookings/${booking.id}/review`,
      payload: (input) => ({ authorId: userId, ...input })
    },
    onSuccess: (review) => onReviewed(review)
  });

  return (
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      <div className="form-grid cols-2">
        <Field id={`rv-rating-${booking.id}`} label="Rating (1–5)">
          <Select id={`rv-rating-${booking.id}`} value={rating} onChange={(e) => setRating(e.target.value)}>
            {[5, 4, 3, 2, 1].map((value) => (
              <option key={value} value={value}>
                {value} star{value === 1 ? '' : 's'}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`rv-comment-${booking.id}`} label="Comment (optional)">
          <TextArea
            id={`rv-comment-${booking.id}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={mutation.status === 'pending'}
          onClick={() => void mutation.mutate({ rating: Number(rating), comment: comment.trim() || undefined })}
        >
          {mutation.status === 'pending' ? 'Saving…' : 'Save review'}
        </button>
      </div>
      {mutation.status === 'queued' ? <StatusBadge tone="warning">review queued for sync</StatusBadge> : null}
      {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}
    </div>
  );
}

function BookingCard({ bookingId, onChanged }: { bookingId: string; onChanged: () => void }) {
  const query = useApiQuery(
    `service-booking:${bookingId}`,
    () => fetchServiceBooking(bookingId).then((res) => res.data),
    { fallbackData: undefined }
  );
  const [reviewed, setReviewed] = useState(false);

  const statusMutation = useApiMutation<{ status: BookingStatus }, ServiceBooking>({
    mutationFn: ({ status }) => setServiceBookingStatus(bookingId, status).then((res) => res.data),
    onSuccess: () => {
      query.refresh();
      onChanged();
    }
  });

  const booking = query.data;
  if (!booking) {
    return query.error ? (
      <ApiErrorNotice error={query.error} onRetry={query.refresh} />
    ) : (
      <p className="small muted">Loading booking…</p>
    );
  }

  return (
    <Card>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Booking #{booking.id.replace('booking-', '')}</h3>
        <AutoBadge value={booking.status} />
      </div>
      <p className="small muted">
        {booking.quantity} unit(s) ·{' '}
        {new Date(booking.scheduledStart).toLocaleDateString('en-NG', { dateStyle: 'medium' })} →{' '}
        {new Date(booking.scheduledEnd).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
        {booking.totalNaira !== undefined ? ` · quoted ${formatNaira(booking.totalNaira)}` : ''}
      </p>
      <Timeline items={bookingTimeline(booking)} />
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        {booking.status === 'quoted' ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={statusMutation.status === 'pending'}
              onClick={() => void statusMutation.mutate({ status: 'accepted' })}
            >
              Accept quote
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={statusMutation.status === 'pending'}
              onClick={() => void statusMutation.mutate({ status: 'declined' })}
            >
              Decline
            </button>
          </>
        ) : null}
        {booking.status === 'requested' || booking.status === 'accepted' || booking.status === 'scheduled' ? (
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={statusMutation.status === 'pending'}
            onClick={() => void statusMutation.mutate({ status: 'cancelled' })}
          >
            Cancel booking
          </button>
        ) : null}
      </div>
      {statusMutation.status === 'error' ? <ApiErrorNotice error={statusMutation.error} /> : null}
      {booking.status === 'completed' && !reviewed ? (
        <ReviewForm booking={booking} onReviewed={() => setReviewed(true)} />
      ) : null}
      {reviewed ? <StatusBadge tone="success">review saved</StatusBadge> : null}
    </Card>
  );
}

export function MyBookings() {
  const [bookingIds, setBookingIds] = usePersistentState<string[]>(MY_BOOKINGS_KEY, []);
  const [, setTick] = useState(0);

  if (bookingIds.length === 0) {
    return (
      <EmptyState
        title="No bookings yet"
        hint="Bookings you request from a supplier appear here, even offline."
      />
    );
  }

  return (
    <div className="stack">
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => setBookingIds([])}
        >
          Clear completed history
        </button>
      </div>
      {bookingIds.map((id) => (
        <BookingCard key={id} bookingId={id} onChanged={() => setTick((tick) => tick + 1)} />
      ))}
    </div>
  );
}
