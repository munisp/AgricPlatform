import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApiClient } from '../api/context';
import { fetchSession, listNotifications, markNotificationRead } from '../api/endpoints';
import type { NotificationMessage } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

/**
 * Notifications inbox (GET /notifications?userId=me). Unread items carry a
 * "Mark read" action (POST /notifications/:id/read); the list reloads after
 * each action so counts stay truthful.
 */
export function NotificationsScreen() {
  const client = useApiClient();
  const [items, setItems] = useState<NotificationMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const session = await fetchSession(client);
      const res = await listNotifications(client, session.data.user.id);
      setItems(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markRead(item: NotificationMessage) {
    setMarking(item.id);
    setError(null);
    try {
      await markNotificationRead(client, item.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark as read');
    } finally {
      setMarking(null);
    }
  }

  if (error && !items) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!items) {
    return <Loading />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {error ? <ErrorNotice message={error} /> : null}
      {items.length === 0 ? (
        <Card>
          <CardTitle>Notifications</CardTitle>
          <Muted>No notifications yet — recalls, order updates and advisories appear here.</Muted>
        </Card>
      ) : (
        items.map((item) => (
          <Card key={item.id}>
            <Text style={styles.title}>
              {item.status === 'read' ? '' : '● '}
              {item.title}
            </Text>
            <Muted>{item.body}</Muted>
            <Muted>
              {item.channel} · {new Date(item.createdAt).toLocaleDateString('en-NG')} · {item.status}
            </Muted>
            {item.status !== 'read' ? (
              <PrimaryButton
                label={marking === item.id ? 'Marking…' : 'Mark read'}
                onPress={() => void markRead(item)}
                disabled={marking !== null}
              />
            ) : null}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  title: { fontSize: 15, fontWeight: '700', marginBottom: 4, color: '#1b1b1b' }
});
