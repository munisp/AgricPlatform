import { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { isAbortError } from '../api/client';
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
 * Rows of the single virtualized list: the draft-confirm section and the
 * orders section are flattened into one FlatList so BOTH server-sized lists
 * window instead of mounting every card up front (perf: ScrollView+.map).
 */
type OrderRow =
  | { kind: 'drafts-header'; id: string }
  | { kind: 'draft'; id: string; draft: DraftOrder }
  | { kind: 'orders-header'; id: string }
  | { kind: 'orders-empty'; id: string }
  | { kind: 'order'; id: string; order: Order };

const OrderCard = memo(function OrderCard({
  order,
  onOpen
}: {
  order: Order;
  onOpen: (orderId: string) => void;
}) {
  return (
    <Card>
      <Text style={styles.line}>
        {order.quantity} units · ₦{order.totalNaira.toLocaleString('en-NG')}
      </Text>
      <Muted>
        Status: {order.status}
        {order.escrowRequired ? ' · escrow' : ''}
      </Muted>
      <PrimaryButton label="View order" onPress={() => onOpen(order.id)} />
    </Card>
  );
});

const DraftCard = memo(function DraftCard({
  draft,
  confirming,
  anyConfirming,
  onConfirm
}: {
  draft: DraftOrder;
  confirming: boolean;
  anyConfirming: boolean;
  onConfirm: (draft: DraftOrder) => void;
}) {
  return (
    <Card>
      <Text style={styles.line}>
        {draft.quantity} × ₦{(draft.unitPriceKobo / 100).toLocaleString('en-NG')}
      </Text>
      <Muted>Listing {draft.listingId} · created by your agent</Muted>
      <PrimaryButton
        label={confirming ? 'Confirming…' : 'Confirm order'}
        onPress={() => onConfirm(draft)}
        disabled={anyConfirming}
      />
    </Card>
  );
});

function rowKey(row: OrderRow): string {
  return row.id;
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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        // The orders/drafts endpoints require the caller's user id (the API
        // 403s any other buyerId), so the lists fan out in parallel off the
        // session promise instead of awaiting it first.
        const buyerIdPromise = fetchSession(client, { signal }).then((res) => res.data.user.id);
        const [orders, drafts] = await Promise.all([
          buyerIdPromise
            .then((buyerId) => listMyOrders(client, buyerId, undefined, { signal }))
            .then((res) => res.data),
          buyerIdPromise
            .then((buyerId) => listDraftOrders(client, buyerId, { signal }))
            .then((res) => res.data)
        ]);
        if (signal?.aborted) return;
        setData({ orders, drafts });
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load your orders');
      }
    },
    [client]
  );

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  const confirm = useCallback(
    async (draft: DraftOrder) => {
      setConfirming(draft.id);
      setError(null);
      try {
        await confirmDraftOrder(client, draft.id);
        await load();
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not confirm the order');
      } finally {
        setConfirming(null);
      }
    },
    [client, load]
  );

  // Stable row list (rebuilt only when data changes) so memoized row
  // components skip re-renders when `confirming`/`refreshing` flip.
  const rows = useMemo<OrderRow[]>(() => {
    if (!data) return [];
    const openDrafts = data.drafts.filter((draft) => draft.status === 'open');
    const list: OrderRow[] = [];
    if (openDrafts.length > 0) {
      list.push({ kind: 'drafts-header', id: 'drafts-header' });
      for (const draft of openDrafts) {
        list.push({ kind: 'draft', id: `draft-${draft.id}`, draft });
      }
    }
    list.push({ kind: 'orders-header', id: 'orders-header' });
    if (data.orders.length === 0) {
      list.push({ kind: 'orders-empty', id: 'orders-empty' });
    } else {
      for (const order of data.orders) {
        list.push({ kind: 'order', id: `order-${order.id}`, order });
      }
    }
    return list;
  }, [data]);

  const renderRow = useCallback(
    ({ item }: { item: OrderRow }) => {
      switch (item.kind) {
        case 'drafts-header':
          return (
            <Card>
              <CardTitle>Draft orders to confirm</CardTitle>
            </Card>
          );
        case 'draft':
          return (
            <DraftCard
              draft={item.draft}
              confirming={confirming === item.draft.id}
              anyConfirming={confirming !== null}
              onConfirm={confirm}
            />
          );
        case 'orders-header':
          return (
            <Card>
              <CardTitle>My orders</CardTitle>
            </Card>
          );
        case 'orders-empty':
          return (
            <Card>
              <Muted>No orders yet — buy produce and inputs from the marketplace.</Muted>
            </Card>
          );
        case 'order':
          return <OrderCard order={item.order} onOpen={onOpenOrder} />;
      }
    },
    [confirming, confirm, onOpenOrder]
  );

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

  return (
    <FlatList
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={rows}
      keyExtractor={rowKey}
      ListHeaderComponent={error ? <ErrorNotice message={error} /> : undefined}
      renderItem={renderRow}
      initialNumToRender={10}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', marginBottom: 4, color: '#1b1b1b' }
});
