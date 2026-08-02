'use client';

import { useState } from 'react';
import { formatNaira, seedListings } from '@agric-platform/shared';
import type { MarketplaceListing } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { listListings, listOrders, placeOrder } from '@/lib/api/endpoints';
import { demoOrders } from '@/lib/content';
import { AutoBadge, Card, StatusBadge } from '@/components/ui';
import { OrderCommercePanel } from '@/components/order-commerce';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallback only — live listings come from GET /api/v1/listings.
const FALLBACK_LISTINGS: MarketplaceListing[] = seedListings;

function ListingCard({ listing }: { listing: MarketplaceListing }) {
  const { userId } = useAppState();
  const [ordered, setOrdered] = useState<'idle' | 'sent' | 'queued'>('idle');
  const orderMutation = useApiMutation<{ quantity: number }, unknown>({
    mutationFn: ({ quantity }) =>
      placeOrder(listing.id, { buyerId: userId, quantity }).then((res) => res.data),
    queue: {
      kind: 'marketplace.order.placed',
      label: () => `Order: ${listing.title}`,
      method: 'POST',
      path: () => `/listings/${listing.id}/orders`,
      payload: ({ quantity }) => ({ buyerId: userId, quantity })
    },
    onSuccess: () => setOrdered('sent'),
    onQueued: () => setOrdered('queued')
  });

  return (
    <Card title={listing.title}>
      <p className="small muted">
        {listing.quantity} {listing.unit} · {listing.location.state}, {listing.location.lga}
        {listing.harvestDate
          ? ` · harvest ${new Date(listing.harvestDate).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`
          : ''}
      </p>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.1rem' }}>{formatNaira(listing.priceNaira)}</span>
        <AutoBadge value={listing.kind} />
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
        {ordered === 'sent' ? (
          <StatusBadge tone="success">order placed</StatusBadge>
        ) : ordered === 'queued' ? (
          <StatusBadge tone="warning">order queued</StatusBadge>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={orderMutation.status === 'pending' || listing.sellerId === userId}
            title={listing.sellerId === userId ? 'This is your own listing' : undefined}
            onClick={() => void orderMutation.mutate({ quantity: 1 })}
          >
            {orderMutation.status === 'pending' ? 'Placing…' : 'Place order'}
          </button>
        )}
      </div>
      {orderMutation.status === 'error' ? <ApiErrorNotice error={orderMutation.error} /> : null}
    </Card>
  );
}

export function ListingBrowser() {
  const query = useApiQuery(
    'listings:active',
    () => listListings({ active: true, pageSize: 60 }).then((res) => res.data),
    { fallbackData: FALLBACK_LISTINGS }
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      </QueryState>
    </>
  );
}

export function OrderList() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `orders:buyer:${userId}` : null,
    () => listOrders({ buyerId: userId }).then((res) => res.data),
    // Offline fallback only — live orders come from GET /api/v1/orders?buyerId=…
    { fallbackData: demoOrders, enabled: hydrated }
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={
          <p className="small muted">No orders yet — place one from an active listing above.</p>
        }
      >
        <div className="stack">
          {(query.data ?? []).map((order) => (
            <Card key={order.id}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>Order #{order.id.replace('order-', '')}</h3>
                <AutoBadge value={order.status} />
              </div>
              <p className="small muted">
                Listing {order.listingId} · {order.quantity} units ·{' '}
                {new Date(order.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 700 }}>{formatNaira(order.totalNaira)}</span>
                {order.escrowRequired ? <StatusBadge tone="warning">escrow held</StatusBadge> : null}
              </div>
              <OrderCommercePanel order={order} />
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}
