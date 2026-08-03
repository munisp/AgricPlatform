import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApiClient } from '../api/context';
import { listMyFarmPlots } from '../api/endpoints';
import type { FarmPlot } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

/**
 * My farm plots (GET /farms/plots — owner-scoped server-side). The capture
 * flow lives on PlotCaptureScreen; this screen is the list + entry point.
 */
export function FarmsScreen({ onCapturePlot }: { onCapturePlot?: () => void }) {
  const client = useApiClient();
  const [plots, setPlots] = useState<FarmPlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listMyFarmPlots(client);
      setPlots(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your plots');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !plots) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!plots) {
    return <Loading />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {error ? <ErrorNotice message={error} /> : null}
      <Card>
        <CardTitle>My plots ({plots.length})</CardTitle>
        {plots.length === 0 ? (
          <Muted>No plots yet — capture your first plot below.</Muted>
        ) : (
          plots.map((plot) => (
            <Card key={plot.id}>
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
          ))
        )}
        {onCapturePlot ? <PrimaryButton label="Capture plot" onPress={onCapturePlot} /> : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', color: '#1b1b1b' }
});
