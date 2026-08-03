import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { useApiClient } from '../api/context';
import {
  confirmDraftOrder,
  fetchSession,
  listDraftOrders,
  listMyOrders
} from '../api/endpoints';
import type { DraftOrder, Order } from '../api/types';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

interface OrdersData {
  orders: Order[];
  drafts: DraftOrder[];
}

/**
 * My orders: purchases (GET /orders?buyerId=me) plus open draft orders an
 * agent created on the buyer's behalf (Wave M) with one-tap confirm.
 */
export function OrdersScreen({
  onOpenOrder
}: {
  onOpenOrder: (orderId: string) => void;
}) {
  const client = useApiClient();
  const [data, setData] = useState<OrdersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const session = await fetchSession(client);
      const buyerId = session.data.user.id;
      const [orders, drafts] = await Promise.all([
        listMyOrders(client, buyerId).then((res) => res.data),
        listDraftOrders(client, buyerId).then((res) => res.data)
      ]);
      setData({ orders, drafts });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your orders');
    }
  }, [client]);

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  async function confirm(draft: DraftOrder) {
    setConfirming(draft.id);
    setError(null);
    try {
      await confirmDraftOrder(client, draft.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm the order');
    } finally {
      setConfirming(null);
    }
  }

  if (error && !data) {
    return (
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!data) {
    return <Loading />;
  }

  const openDrafts = data.drafts.filter((draft) => draft.status === 'open');

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      {error ? <ErrorNotice message={error} /> : null}

      {openDrafts.length > 0 ? (
        <Card>
          <CardTitle>Draft orders to confirm</CardTitle>
          {openDrafts.map((draft) => (
            <Card key={draft.id}>
              <Text style={styles.line}>
                {draft.quantity} × ₦{(draft.unitPriceKobo / 100).toLocaleString('en-NG')}
              </Text>
              <Muted>Listing {draft.listingId} · created by your agent</Muted>
              <PrimaryButton
                label={confirming === draft.id ? 'Confirming…' : 'Confirm order'}
                onPress={() => void confirm(draft)}
                disabled={confirming !== null}
              />
            </Card>
          ))}
        </Card>
      ) : null}

      <Card>
        <CardTitle>My orders</CardTitle>
        {data.orders.length === 0 ? (
          <Muted>No orders yet — buy produce and inputs from the marketplace.</Muted>
        ) : (
          data.orders.map((order) => (
            <Card key={order.id}>
              <Text style={styles.line}>
                {order.quantity} units · ₦{order.totalNaira.toLocaleString('en-NG')}
              </Text>
              <Muted>
                Status: {order.status}
                {order.escrowRequired ? ' · escrow' : ''}
              </Muted>
              <PrimaryButton label="View order" onPress={() => onOpenOrder(order.id)} />
            </Card>
          ))
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', marginBottom: 4, color: '#1b1b1b' }
});
