import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { listMyFarmPlots } from '../api/endpoints';
import type { FarmPlot } from '../api/types';
import { useSyncStatus, useSyncStore } from '../sync/context';
import { SYNC_ENTITY_FARM_PLOT } from '../sync/entities';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

/** A plot row: a server plot, or a sync-cache record not (yet) confirmed. */
interface PlotRow {
  plot: FarmPlot;
  /** True while the record only exists in the local sync outbox/cache. */
  pending: boolean;
}

const PlotCard = memo(function PlotCard({ row }: { row: PlotRow }) {
  const { plot, pending } = row;
  return (
    <Card>
      <Text style={styles.line}>{plot.name}</Text>
      <Muted>
        {plot.lga}, {plot.state} · {plot.sizeHectares} ha
        {plot.soilType ? ` · ${plot.soilType}` : ''}
      </Muted>
      <Muted>
        {plot.centroidLat.toFixed(5)}, {plot.centroidLong.toFixed(5)}
        {plot.boundaryGeojson ? ' · boundary captured' : ''}
        {pending ? ' · pending sync' : ` · v${plot.version}`}
      </Muted>
    </Card>
  );
});

function plotKey(row: PlotRow): string {
  return row.plot.id;
}

const renderPlot = ({ item }: { item: PlotRow }) => <PlotCard row={item} />;

/**
 * Cache-payload guard: farm_plot sync records carry the capture payload
 * (CreateFarmPlotInput shape); the record id lives on the envelope.
 */
function asPlot(entityId: string, version: number, payload: unknown): FarmPlot | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<FarmPlot>;
  if (typeof candidate.name !== 'string') return null;
  if (typeof candidate.centroidLat !== 'number' || typeof candidate.centroidLong !== 'number') {
    return null;
  }
  return {
    id: entityId,
    ownerUserId: candidate.ownerUserId ?? '',
    name: candidate.name,
    state: candidate.state ?? '',
    lga: candidate.lga ?? '',
    centroidLat: candidate.centroidLat,
    centroidLong: candidate.centroidLong,
    boundaryGeojson: candidate.boundaryGeojson,
    sizeHectares: typeof candidate.sizeHectares === 'number' ? candidate.sizeHectares : 0,
    soilType: candidate.soilType,
    accuracyMeters: candidate.accuracyMeters,
    createdAt: candidate.createdAt ?? '',
    updatedAt: candidate.updatedAt ?? '',
    version,
    clientId: candidate.clientId
  };
}

/**
 * My farm plots (GET /farms/plots — owner-scoped server-side). The capture
 * flow lives on PlotCaptureScreen; this screen is the list + entry point.
 *
 * Offline captures (GAP-M24): plots still sitting in the record-level sync
 * outbox/cache are MERGED into the list — flagged "pending sync" — so an
 * offline capture never looks lost. The useSyncStatus subscription
 * re-renders the screen when the outbox/cache changes (push applied → the
 * row flips from pending to its server version on the next refresh).
 */
export function FarmsScreen({ onCapturePlot }: { onCapturePlot?: () => void }) {
  const client = useApiClient();
  const store = useSyncStore();
  useSyncStatus(store); // re-render when the sync cache/outbox changes
  const [plots, setPlots] = useState<FarmPlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      // Hydrate the sync cache so pending offline captures are visible even
      // when the server list cannot load (GAP-M24); hydrate() notifies
      // subscribers, re-rendering the merged rows.
      await store.hydrate();
      try {
        const res = await listMyFarmPlots(client, { signal });
        if (signal?.aborted) return;
        setPlots(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load your plots');
      }
    },
    [client, store]
  );

  // Reload on mount + whenever this screen regains focus (e.g. after
  // PlotCapture onSaved → goBack), plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  // Merge server plots with sync-cache records they don't know yet
  // (offline captures pending their first push), deduped by id.
  const serverIds = new Set((plots ?? []).map((plot) => plot.id));
  const cachedRows: PlotRow[] = store
    .getRecords(SYNC_ENTITY_FARM_PLOT)
    .filter((record) => !serverIds.has(record.entityId))
    .map((record) => {
      const plot = asPlot(record.entityId, record.version, record.payload);
      return plot ? { plot, pending: record.pending || record.version === 0 } : null;
    })
    .filter((row): row is PlotRow => row !== null);
  const rows: PlotRow[] = [
    ...cachedRows,
    ...(plots ?? []).map((plot) => ({ plot, pending: false }))
  ];

  if (error && !plots && rows.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!plots && rows.length === 0) {
    return <Loading />;
  }

  return (
    <FlatList
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={rows}
      keyExtractor={plotKey}
      ListHeaderComponent={
        <>
          {error ? <ErrorNotice message={error} /> : null}
          <Card>
            <CardTitle>My plots ({rows.length})</CardTitle>
            {rows.length === 0 ? (
              <Muted>No plots yet — capture your first plot below.</Muted>
            ) : null}
          </Card>
        </>
      }
      renderItem={renderPlot}
      ListFooterComponent={
        onCapturePlot ? (
          <Card>
            <PrimaryButton label="Capture plot" onPress={onCapturePlot} />
          </Card>
        ) : undefined
      }
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', color: '#1b1b1b' }
});
