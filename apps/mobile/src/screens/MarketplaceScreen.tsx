import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useApiClient } from '../api/context';
import { listListings } from '../api/endpoints';
import type { MarketplaceListing } from '../api/types';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

export function MarketplaceScreen({
  onOpenListing
}: {
  onOpenListing: (listingId: string) => void;
}) {
  const client = useApiClient();
  const [listings, setListings] = useState<MarketplaceListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listListings(client, { pageSize: 50 });
      setListings(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load listings');
    }
  }, [client]);

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

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
      keyExtractor={(listing) => listing.id}
      ListEmptyComponent={
        <Card>
          <CardTitle>No listings right now</CardTitle>
          <Muted>Produce, inputs and services will appear here.</Muted>
        </Card>
      }
      renderItem={({ item }) => (
        <Card>
          <CardTitle>{item.title}</CardTitle>
          <Muted>
            {item.kind} · {item.quantity} {item.unit} · {formatNaira(item.priceNaira)} ·{' '}
            {item.location.state}
          </Muted>
          <PrimaryButton label="View listing" onPress={() => onOpenListing(item.id)} />
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' }
});
