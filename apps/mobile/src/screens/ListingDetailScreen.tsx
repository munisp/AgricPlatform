import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { buildPlaceOrderBody, fetchListing, fetchSession, placeOrder } from '../api/endpoints';
import type { MarketplaceListing } from '../api/types';
import type { OfflineQueue } from '../offline/queue';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton, styles as uiStyles } from './ui';

/**
 * Listing detail + the buyer's purchase action (GAP-H11).
 *
 * Offline-first, mirroring AgentQueueScreen: when an OfflineQueue is
 * provided the order is enqueued FIRST (stable idempotency key, kind
 * 'marketplace.order.created' so it ages out per the V-64 TTL map) and the
 * queue is then flushed through the API client. The queued payload is built
 * by the SAME body-builder as the online wrapper (buildPlaceOrderBody), so
 * a replay applies exactly the online request. A failed flush leaves the
 * order parked for the connectivity sync instead of losing it.
 */
export function ListingDetailScreen({
  listingId,
  queue
}: {
  listingId: string;
  queue?: OfflineQueue;
}) {
  const client = useApiClient();
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState<'idle' | 'placing' | 'placed' | 'queued'>('idle');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await fetchListing(client, listingId, { signal });
        if (signal?.aborted) return;
        setListing(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load this listing');
      }
    },
    [client, listingId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const buy = useCallback(
    async (target: MarketplaceListing) => {
      setOrdering('placing');
      setError(null);
      try {
        const session = await fetchSession(client);
        const buyerId = session.data.user.id;
        if (buyerId === target.sellerId) {
          setError('This is your own listing — you cannot order from yourself.');
          setOrdering('idle');
          return;
        }
        const input = { buyerId, quantity: 1 };
        // Stable per buy attempt: the queue dedupes double-taps on it, and a
        // replay replays the ORIGINAL order server-side (Idempotency-Key).
        const idempotencyKey = `marketplace.order:${target.id}:${buyerId}:${Math.random()
          .toString(36)
          .slice(2, 12)}`;
        if (queue) {
          await queue.enqueue({
            kind: 'marketplace.order.created',
            method: 'POST',
            path: `/listings/${encodeURIComponent(target.id)}/orders`,
            payload: buildPlaceOrderBody(input),
            idempotencyKey,
            // Orders on one listing form a dependency chain: a failed replay
            // blocks later buys of the same listing until the next flush.
            chainKey: `marketplace.listing:${target.id}`
          });
          await queue.flush((request) =>
            client.apiFetch(request.path, {
              method: request.method,
              body: request.payload,
              idempotencyKey: request.idempotencyKey
            })
          );
          const stillPending = (await queue.pending()).some(
            (entry) => entry.idempotencyKey === idempotencyKey
          );
          if (stillPending) {
            setOrdering('queued');
            return;
          }
        } else {
          await placeOrder(client, target.id, input, idempotencyKey);
        }
        setOrdering('placed');
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not place the order');
        setOrdering('idle');
      }
    },
    [client, queue]
  );

  if (error && !listing) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!listing) {
    return <Loading />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card>
        <CardTitle>{listing.title}</CardTitle>
        <Muted>
          {listing.kind}
          {listing.crop ? ` · ${listing.crop}` : ''} · {listing.quantity} {listing.unit} · ₦
          {listing.priceNaira.toLocaleString('en-NG')}
        </Muted>
        <Muted>
          {listing.location.lga ? `${listing.location.lga}, ` : ''}
          {listing.location.state}
        </Muted>
        {listing.harvestDate ? <Muted>Harvest: {listing.harvestDate.slice(0, 10)}</Muted> : null}
      </Card>
      {error ? <ErrorNotice message={error} /> : null}
      {ordering === 'queued' ? (
        <View style={uiStyles.notice}>
          <Text style={uiStyles.noticeText}>
            No connection — your order is queued and will be placed when you are back online.
          </Text>
        </View>
      ) : null}
      <Card>
        {ordering === 'placed' ? (
          <Muted>Order placed — track it under My orders.</Muted>
        ) : ordering === 'queued' ? (
          <Muted>Order queued for sync.</Muted>
        ) : (
          <PrimaryButton
            label={ordering === 'placing' ? 'Placing order…' : 'Place order'}
            disabled={ordering === 'placing'}
            onPress={() => void buy(listing)}
          />
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' }
});
