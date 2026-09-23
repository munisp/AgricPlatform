import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { fetchSession, listNotifications, markNotificationRead } from '../api/endpoints';
import type { NotificationMessage } from '../api/types';
import { useSyncStatus, useSyncStore } from '../sync/context';
import { SyncBadge } from '../sync/SyncBadge';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton, styles as uiStyles } from './ui';

const SYNC_ENTITY = 'notification';

function asNotification(payload: unknown): NotificationMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<NotificationMessage>;
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return null;
  return candidate as NotificationMessage;
}

const NotificationCard = memo(function NotificationCard({
  item,
  marking,
  anyMarking,
  onMarkRead
}: {
  item: NotificationMessage;
  marking: boolean;
  anyMarking: boolean;
  onMarkRead: (item: NotificationMessage) => void;
}) {
  return (
    <Card>
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
          label={marking ? 'Marking…' : 'Mark read'}
          onPress={() => onMarkRead(item)}
          disabled={anyMarking}
        />
      ) : null}
    </Card>
  );
});

function notificationKey(item: NotificationMessage): string {
  return item.id;
}

/**
 * Notifications inbox, backed by the record-level sync cache
 * (Wave SYNCCLIENT, docs/sync-protocol.md):
 *
 * 1. Opening the screen is an explicit sync point — syncNow(['notification'])
 *    pulls server changes into the cache (cursors + tombstones).
 * 2. The list renders from the cache, so re-opening the screen offline shows
 *    the last synced data with an honest "saved data" notice.
 * 3. If the sync pull fails and the cache is still empty (e.g. first launch
 *    against a server without the sync wave), the screen falls back to the
 *    legacy direct endpoint before giving up with an error.
 *
 * "Mark read" stays a direct API call (notifications are read-only in sync
 * v1 — the server is the only writer); the list re-syncs afterwards so the
 * cache picks up the server-side version bump. The tapped row flips to read
 * optimistically as soon as the POST resolves, without waiting for the
 * re-sync round trip.
 */
export function NotificationsScreen() {
  const client = useApiClient();
  const store = useSyncStore();
  const status = useSyncStatus(store);
  const [items, setItems] = useState<NotificationMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);

  const readCache = useCallback((): NotificationMessage[] => {
    return store
      .getRecords(SYNC_ENTITY)
      .map((record) => asNotification(record.payload))
      .filter((item): item is NotificationMessage => item !== null);
  }, [store]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      const summary = await store.syncNow([SYNC_ENTITY]);
      if (signal?.aborted) return;
      const pullFailed = summary.errors.some((entry) => entry.phase === 'pull');
      const cached = readCache();
      if (!pullFailed) {
        setItems(cached);
        setFromCache(false);
        return;
      }
      if (cached.length > 0) {
        // Offline (or server unreachable): cached records, no data loss.
        setItems(cached);
        setFromCache(true);
        return;
      }
      // Nothing cached yet — legacy direct read before giving up.
      try {
        const session = await fetchSession(client, { signal });
        const res = await listNotifications(client, session.data.user.id, { signal });
        if (signal?.aborted) return;
        setItems(res.data);
        setFromCache(false);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load notifications');
      }
    },
    [client, store, readCache]
  );

  // Re-sync on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  const markRead = useCallback(
    async (item: NotificationMessage) => {
      setMarking(item.id);
      setError(null);
      try {
        await markNotificationRead(client, item.id);
        // Optimistic: clear the unread dot immediately, then re-sync the
        // cache so the server-side version bump is picked up (the re-sync
        // is part of the contract — see the sync notifications tests).
        setItems((current) =>
          current
            ? current.map((entry) =>
                entry.id === item.id ? { ...entry, status: 'read' } : entry
              )
            : current
        );
        await load();
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not mark as read');
      } finally {
        setMarking(null);
      }
    },
    [client, load]
  );

  const renderItem = useCallback(
    ({ item }: { item: NotificationMessage }) => (
      <NotificationCard
        item={item}
        marking={marking === item.id}
        anyMarking={marking !== null}
        onMarkRead={markRead}
      />
    ),
    [marking, markRead]
  );

  if (error && !items) {
    return (
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!items) {
    return <Loading />;
  }

  return (
    <FlatList
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={items}
      keyExtractor={notificationKey}
      ListHeaderComponent={
        <>
          <SyncBadge status={status} />
          {error ? <ErrorNotice message={error} /> : null}
          {fromCache ? (
            <View style={uiStyles.notice}>
              <Text style={uiStyles.noticeText}>
                You appear to be offline — showing your last synced notifications.
              </Text>
            </View>
          ) : null}
        </>
      }
      ListEmptyComponent={
        <Card>
          <CardTitle>Notifications</CardTitle>
          <Muted>No notifications yet — recalls, order updates and advisories appear here.</Muted>
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
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  title: { fontSize: 15, fontWeight: '700', marginBottom: 4, color: '#1b1b1b' }
});
