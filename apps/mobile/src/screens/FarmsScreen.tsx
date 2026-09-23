import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { listMyFarmPlots } from '../api/endpoints';
import type { FarmPlot } from '../api/types';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

const PlotCard = memo(function PlotCard({ plot }: { plot: FarmPlot }) {
  return (
    <Card>
      <Text style={styles.line}>{plot.name}</Text>
      <Muted>
        {plot.lga}, {plot.state} · {plot.sizeHectares} ha
        {plot.soilType ? ` · ${plot.soilType}` : ''}
      </Muted>
      <Muted>
        {plot.centroidLat.toFixed(5)}, {plot.centroidLong.toFixed(5)}
        {plot.boundaryGeojson ? ' · boundary captured' : ''} · v{plot.version}
      </Muted>
    </Card>
  );
});

function plotKey(plot: FarmPlot): string {
  return plot.id;
}

const renderPlot = ({ item }: { item: FarmPlot }) => <PlotCard plot={item} />;

/**
 * My farm plots (GET /farms/plots — owner-scoped server-side). The capture
 * flow lives on PlotCaptureScreen; this screen is the list + entry point.
 */
export function FarmsScreen({ onCapturePlot }: { onCapturePlot?: () => void }) {
  const client = useApiClient();
  const [plots, setPlots] = useState<FarmPlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await listMyFarmPlots(client, { signal });
        if (signal?.aborted) return;
        setPlots(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load your plots');
      }
    },
    [client]
  );

  // Reload on mount + whenever this screen regains focus (e.g. after
  // PlotCapture onSaved → goBack), plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  if (error && !plots) {
    return (
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!plots) {
    return <Loading />;
  }

  return (
    <FlatList
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={plots}
      keyExtractor={plotKey}
      ListHeaderComponent={
        <>
          {error ? <ErrorNotice message={error} /> : null}
          <Card>
            <CardTitle>My plots ({plots.length})</CardTitle>
            {plots.length === 0 ? (
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
