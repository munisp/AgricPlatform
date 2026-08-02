import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApiClient } from '../api/context';
import { fetchOrder } from '../api/endpoints';
import { ORDER_STATUSES, type Order, type OrderStatus } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted } from './ui';

/** Happy-path progression used to render the order timeline. */
const TIMELINE: OrderStatus[] = ['placed', 'deposit_paid', 'in_fulfilment', 'delivered', 'completed'];

const STATUS_LABELS: Record<OrderStatus, string> = {
  placed: 'Order placed',
  deposit_paid: 'Deposit paid',
  in_fulfilment: 'Being prepared',
  delivered: 'Delivered',
  completed: 'Completed',
  disputed: 'Disputed',
  cancelled: 'Cancelled'
};

function timelineIndex(status: OrderStatus): number {
  return TIMELINE.indexOf(status);
}

/**
 * Order detail with a status timeline: every happy-path step is shown,
 * completed steps are ticked, terminal states (disputed/cancelled) replace
 * the remaining steps.
 */
export function OrderDetailScreen({ orderId }: { orderId: string }) {
  const client = useApiClient();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchOrder(client, orderId);
      setOrder(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the order');
    }
  }, [client, orderId]);

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
  if (!order) {
    return <Loading />;
  }

  const current = timelineIndex(order.status);
  const terminal = order.status === 'disputed' || order.status === 'cancelled';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card>
        <CardTitle>Order {order.id}</CardTitle>
        <Text style={styles.line}>
          {order.quantity} units · ₦{order.totalNaira.toLocaleString('en-NG')}
        </Text>
        <Muted>
          Listing {order.listingId}
          {order.escrowRequired ? ' · escrow protected' : ''}
        </Muted>
      </Card>

      <Card>
        <CardTitle>Progress</CardTitle>
        {TIMELINE.map((step, index) => {
          const reached = !terminal && current >= index;
          return (
            <View key={step} style={styles.step}>
              <Text style={[styles.tick, reached ? styles.tickDone : null]}>
                {reached ? '✓' : '○'}
              </Text>
              <Text style={[styles.stepLabel, reached ? styles.stepDone : null]}>
                {STATUS_LABELS[step]}
              </Text>
            </View>
          );
        })}
        {terminal ? (
          <Muted>
            This order is {STATUS_LABELS[order.status].toLowerCase()}. Contact support if you
            need help.
          </Muted>
        ) : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', marginBottom: 4, color: '#1b1b1b' },
  step: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  tick: { width: 24, fontSize: 16, color: '#9e9e9e' },
  tickDone: { color: '#1b5e20' },
  stepLabel: { fontSize: 14, color: '#9e9e9e' },
  stepDone: { color: '#1b1b1b', fontWeight: '600' }
});

// ORDER_STATUSES is re-exported for tests that assert timeline coverage.
export { ORDER_STATUSES };
