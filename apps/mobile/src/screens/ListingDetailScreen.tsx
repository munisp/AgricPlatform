import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useApiClient } from '../api/context';
import { fetchListing } from '../api/endpoints';
import type { MarketplaceListing } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted } from './ui';

export function ListingDetailScreen({ listingId }: { listingId: string }) {
  const client = useApiClient();
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchListing(client, listingId);
      setListing(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this listing');
    }
  }, [client, listingId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' }
});
