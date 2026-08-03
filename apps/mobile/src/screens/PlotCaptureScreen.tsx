import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { useApiClient } from '../api/context';
import { createFarmPlot } from '../api/endpoints';
import type { CreateFarmPlotInput, FarmPlot } from '../api/types';
import {
  createInMemoryStorage,
  createOfflineQueue,
  type OfflineQueue
} from '../offline/queue';
import { Card, CardTitle, ErrorNotice, Muted, PrimaryButton } from './ui';

/** A single GPS reading. */
export interface GeoPoint {
  lat: number;
  long: number;
  accuracyMeters?: number;
}

/**
 * GPS provider abstraction — the production app injects an expo-location
 * adapter; tests inject a stub. The default FAILS CLOSED: no silent fake
 * coordinates ever reach a plot record.
 */
export interface LocationService {
  getCurrentPoint(): Promise<GeoPoint>;
}

const unconfiguredLocationService: LocationService = {
  getCurrentPoint: () =>
    Promise.reject(new Error('No GPS provider configured on this device build'))
};

/**
 * Plot capture: name/LGA/size form with GPS centroid capture and a
 * walk-the-perimeter boundary point list (≥3 points become a closed GeoJSON
 * Polygon). Writes go through the offline queue with a stable idempotency
 * key, so a capture made in the field with no signal replays exactly once
 * when the device reconnects.
 */
export function PlotCaptureScreen({
  state = 'Kano',
  locationService = unconfiguredLocationService,
  queue,
  onSaved
}: {
  state?: string;
  locationService?: LocationService;
  queue?: OfflineQueue;
  onSaved?: (plot: FarmPlot) => void;
}) {
  const client = useApiClient();
  // Default queue is module-scoped in-memory (AsyncStorage adapter lands
  // with the expo secure-store wave, same as the token store).
  const offlineQueue = useMemo(
    () => queue ?? createOfflineQueue(createInMemoryStorage()),
    [queue]
  );

  const [name, setName] = useState('');
  const [lga, setLga] = useState('');
  const [sizeHectares, setSize] = useState('');
  const [centroid, setCentroid] = useState<GeoPoint | null>(null);
  const [boundary, setBoundary] = useState<GeoPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function captureCentroid() {
    setError(null);
    try {
      setCentroid(await locationService.getCurrentPoint());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read GPS');
    }
  }

  async function addBoundaryPoint() {
    setError(null);
    try {
      const point = await locationService.getCurrentPoint();
      setBoundary((points) => [...points, point]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read GPS');
    }
  }

  function boundaryGeojson(): unknown | undefined {
    if (boundary.length < 3) return undefined;
    const ring = [...boundary.map((point) => [point.long, point.lat])];
    ring.push([boundary[0].long, boundary[0].lat]); // close the ring
    return { type: 'Polygon', coordinates: [ring] };
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!centroid) {
        throw new Error('Capture the plot centre point first');
      }
      const hectares = Number(sizeHectares);
      if (!Number.isFinite(hectares) || hectares <= 0) {
        throw new Error('Enter the plot size in hectares');
      }
      const input: CreateFarmPlotInput = {
        name: name.trim(),
        state,
        lga: lga.trim(),
        centroidLat: centroid.lat,
        centroidLong: centroid.long,
        boundaryGeojson: boundaryGeojson(),
        sizeHectares: hectares
      };
      // Stable idempotency key per logical capture: enqueue dedupes on it,
      // so a double-tap or a replay cannot create two plots.
      const idempotencyKey = `farms.plot.${centroid.lat.toFixed(5)}.${centroid.long.toFixed(5)}.${input.name}`;
      await offlineQueue.enqueue({
        kind: 'farms.plot.created',
        method: 'POST',
        path: '/farms/plots',
        payload: input,
        idempotencyKey
      });
      const result = await offlineQueue.flush(async (request) => {
        const res = await createFarmPlot(
          client,
          request.payload as CreateFarmPlotInput,
          request.idempotencyKey
        );
        onSaved?.(res.data);
      });
      setNotice(
        result.sent > 0
          ? 'Plot saved.'
          : 'No connection — the plot is queued and will sync when you are back online.'
      );
      if (result.sent > 0) {
        setName('');
        setLga('');
        setSize('');
        setCentroid(null);
        setBoundary([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the plot');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {error ? <ErrorNotice message={error} /> : null}
      {notice ? <Muted>{notice}</Muted> : null}

      <Card>
        <CardTitle>Capture a plot</CardTitle>
        <Text style={styles.label}>Plot name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} />
        <Text style={styles.label}>LGA</Text>
        <TextInput style={styles.input} value={lga} onChangeText={setLga} />
        <Text style={styles.label}>Size (hectares)</Text>
        <TextInput
          style={styles.input}
          value={sizeHectares}
          onChangeText={setSize}
          keyboardType="numeric"
        />
        <Text style={styles.label}>State</Text>
        <Muted>{state}</Muted>
      </Card>

      <Card>
        <CardTitle>GPS centre</CardTitle>
        {centroid ? (
          <Muted>
            {centroid.lat.toFixed(5)}, {centroid.long.toFixed(5)}
            {centroid.accuracyMeters ? ` · ±${Math.round(centroid.accuracyMeters)} m` : ''}
          </Muted>
        ) : (
          <Muted>No centre point captured yet.</Muted>
        )}
        <PrimaryButton label="Capture centre point" onPress={() => void captureCentroid()} />
      </Card>

      <Card>
        <CardTitle>Boundary ({boundary.length} points)</CardTitle>
        {boundary.length === 0 ? (
          <Muted>Walk the perimeter and add at least 3 points.</Muted>
        ) : (
          boundary.map((point, index) => (
            <Muted key={`${point.lat}-${point.long}-${index}`}>
              {index + 1}. {point.lat.toFixed(5)}, {point.long.toFixed(5)}
            </Muted>
          ))
        )}
        <PrimaryButton label="Add boundary point" onPress={() => void addBoundaryPoint()} />
        {boundary.length > 0 ? (
          <PrimaryButton label="Clear boundary" onPress={() => setBoundary([])} />
        ) : null}
      </Card>

      <PrimaryButton label={busy ? 'Saving…' : 'Save plot'} disabled={busy} onPress={() => void submit()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  label: { fontSize: 13, fontWeight: '600', color: '#1b1b1b', marginTop: 8 },
  input: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    padding: 10,
    marginTop: 4
  }
});
