import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { listListings } from '../api/endpoints';
import type { MarketplaceListing } from '../api/types';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
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

export function MarketplaceScreen({
  onOpenListing
}: {
  onOpenListing: (listingId: string) => void;
}) {
  const client = useApiClient();
  const [listings, setListings] = useState<MarketplaceListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await listListings(client, { pageSize: 50 }, { signal });
        if (signal?.aborted) return;
        setListings(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load listings');
      }
    },
    [client]
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

  if (error) {
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
