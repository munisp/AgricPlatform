import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { useApiClient } from '../api/context';
import { createFarmPlot } from '../api/endpoints';
import type { CreateFarmPlotInput, FarmPlot } from '../api/types';
import {
  GOOD_FIX_ACCURACY_METERS,
  LocationPermissionDeniedError,
  type GeoPoint,
  type LocationService
} from '../location/location-service';
import {
  createInMemoryStorage,
  createOfflineQueue,
  type OfflineQueue
} from '../offline/queue';
import { Card, CardTitle, ErrorNotice, Muted, PrimaryButton } from './ui';

export type { GeoPoint, LocationService } from '../location/location-service';

/**
 * Default when no GPS provider is injected — FAILS CLOSED: no silent fake
 * coordinates ever reach a plot record. App.tsx injects the real
 * expo-location adapter (src/location/location-service.ts).
 */
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
  // GPS UX (audit P2-15): dedicated states for permission-denied guidance
  // and poor-accuracy warnings instead of one opaque error string.
  const [permissionDenied, setPermissionDenied] = useState<LocationPermissionDeniedError | null>(
    null
  );
  const [accuracyWarning, setAccuracyWarning] = useState<string | null>(null);

  function handleCapturedPoint(point: GeoPoint): void {
    setPermissionDenied(null);
    if (point.accuracyMeters !== undefined && point.accuracyMeters > GOOD_FIX_ACCURACY_METERS) {
      setAccuracyWarning(
        `GPS accuracy is low (±${Math.round(point.accuracyMeters)} m). ` +
          'Move away from buildings/tree cover into the open and capture the point again for a reliable plot map.'
      );
    } else {
      setAccuracyWarning(null);
    }
  }

  function handleCaptureError(err: unknown): void {
    if (err instanceof LocationPermissionDeniedError) {
      setPermissionDenied(err);
      setError(null);
      return;
    }
    setError(err instanceof Error ? err.message : 'Could not read GPS');
  }

  async function captureCentroid() {
    setError(null);
    try {
      const point = await locationService.getCurrentPoint();
      setCentroid(point);
      handleCapturedPoint(point);
    } catch (err) {
      handleCaptureError(err);
    }
  }

  async function addBoundaryPoint() {
    setError(null);
    try {
      const point = await locationService.getCurrentPoint();
      setBoundary((points) => [...points, point]);
      handleCapturedPoint(point);
    } catch (err) {
      handleCaptureError(err);
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
      // so a double-tap or a replay cannot create two plots. The key covers
      // EVERY editable field (audit P2-17) — a legitimate edit (e.g. fixing
      // the LGA after a failed send) produces a different key and is not
      // deduped away.
      const idempotencyKey = [
        'farms.plot',
        centroid.lat.toFixed(5),
        centroid.long.toFixed(5),
        input.name,
        input.state,
        input.lga,
        input.sizeHectares
      ].join('.');
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
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      {error ? <ErrorNotice message={error} /> : null}
      {notice ? <Muted>{notice}</Muted> : null}

      {permissionDenied ? (
        <Card>
          <CardTitle>Location permission needed</CardTitle>
          <Muted>
            AgricPlatform uses your GPS only to map this plot&apos;s centre and boundary — nothing
            else.
          </Muted>
          <Muted>
            {permissionDenied.canAskAgain
              ? 'Tap a capture button again and choose "Allow" when Android/iOS asks for location access.'
              : 'Open your device Settings → Apps → AgricPlatform → Permissions, allow Location, then come back and capture again.'}
          </Muted>
        </Card>
      ) : null}

      {accuracyWarning ? (
        <Card>
          <CardTitle>Low GPS accuracy</CardTitle>
          <Muted>{accuracyWarning}</Muted>
        </Card>
      ) : null}

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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
