import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { listListings } from '../api/endpoints';
import type { MarketplaceListing } from '../api/types';
import { useSyncStatus, useSyncStore } from '../sync/context';
import { SYNC_ENTITY_MARKETPLACE_LISTING } from '../sync/entities';
import { SyncBadge } from '../sync/SyncBadge';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton, styles as uiStyles } from './ui';

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

function asListing(payload: unknown): MarketplaceListing | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<MarketplaceListing>;
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return null;
  if (typeof candidate.priceNaira !== 'number' || typeof candidate.quantity !== 'number') return null;
  return candidate as MarketplaceListing;
}

const ListingCard = memo(function ListingCard({
  listing,
  onOpen
}: {
  listing: MarketplaceListing;
  onOpen: (listingId: string) => void;
}) {
  return (
    <Card>
      <CardTitle>{listing.title}</CardTitle>
      <Muted>
        {listing.kind} · {listing.quantity} {listing.unit} · {formatNaira(listing.priceNaira)} ·{' '}
        {listing.location.state}
      </Muted>
      <PrimaryButton label="View listing" onPress={() => onOpen(listing.id)} />
    </Card>
  );
});

function listingKey(listing: MarketplaceListing): string {
  return listing.id;
}

/**
 * Marketplace browse (GAP-M26): the live list comes from GET /listings; the
 * record-level sync cache (`marketplace_listing`, pulled by the
 * connectivity/foreground sync and refreshed on open) is MERGED in, so the
 * seller's own synced listings survive offline. When the fetch fails and
 * the cache has data, the screen serves the last synced listings with an
 * honest "saved data" notice (NotificationsScreen pattern).
 */
export function MarketplaceScreen({
  onOpenListing
}: {
  onOpenListing: (listingId: string) => void;
}) {
  const client = useApiClient();
  const store = useSyncStore();
  const status = useSyncStatus(store);
  const [listings, setListings] = useState<MarketplaceListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const readCache = useCallback((): MarketplaceListing[] => {
    return store
      .getRecords(SYNC_ENTITY_MARKETPLACE_LISTING)
      .map((record) => asListing(record.payload))
      .filter((item): item is MarketplaceListing => item !== null);
  }, [store]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      // Refresh the listing cache (owner-scoped server-side); a failed pull
      // never destroys cached state, so ignore failures here.
      await store.pullEntity(SYNC_ENTITY_MARKETPLACE_LISTING).catch(() => undefined);
      if (signal?.aborted) return;
      const cached = readCache();
      try {
        const res = await listListings(client, { pageSize: 50 }, { signal });
        if (signal?.aborted) return;
        // Merge: live list first, then any synced records the list missed
        // (e.g. own listings beyond the page window), deduped by id.
        const liveIds = new Set(res.data.map((listing) => listing.id));
        setListings([...res.data, ...cached.filter((listing) => !liveIds.has(listing.id))]);
        setFromCache(false);
      } catch (err) {
        if (isAbortError(err)) return;
        if (cached.length > 0) {
          // Offline (or server unreachable): cached records, no data loss.
          setListings(cached);
          setFromCache(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load listings');
      }
    },
    [client, store, readCache]
  );

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  // Stable across `refreshing`/`error` flips so memoized rows skip re-renders.
  const renderItem = useCallback(
    ({ item }: { item: MarketplaceListing }) => (
      <ListingCard listing={item} onOpen={onOpenListing} />
    ),
    [onOpenListing]
  );

  if (error && !listings) {
    return (
      <View style={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </View>
    );
  }
  if (!listings) {
    return <Loading />;
  }

  return (
    <FlatList
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={listings}
      keyExtractor={listingKey}
      ListHeaderComponent={
        <>
          <SyncBadge status={status} />
          {error ? <ErrorNotice message={error} /> : null}
          {fromCache ? (
            <View style={uiStyles.notice}>
              <Text style={uiStyles.noticeText}>
                You appear to be offline — showing your last synced listings.
              </Text>
            </View>
          ) : null}
        </>
      }
      ListEmptyComponent={
        <Card>
          <CardTitle>No listings right now</CardTitle>
          <Muted>Produce, inputs and services will appear here.</Muted>
        </Card>
      }
      renderItem={renderItem}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' }
});
