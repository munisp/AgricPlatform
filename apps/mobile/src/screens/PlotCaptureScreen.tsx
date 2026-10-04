import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createPlot, fetchSession, type CreatePlotInput } from '../api/endpoints';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { enqueuePlotCreate } from '../offline/enqueue';
import { createInMemoryStorage, createOfflineQueue, type OfflineQueue } from '../offline/queue';
import { NIGERIAN_STATES } from '../data/nigeria';
import { Card, CardTitle, ErrorNotice, Field, Muted, PrimaryButton, styles as uiStyles } from './ui';

const SOIL_TYPES = ['sandy', 'loamy', 'clay', 'silt', 'peat', 'unknown'] as const;

/**
 * First-mile plot capture (GAP-I02 mobile surface): a farmer without
 * connectivity walks their field, captures the centroid and basic
 * attributes, and saves. When a queue is provided the mutation is
 * ENQUEUED FIRST with a stable per-form idempotency key and then flushed
 * — identical doctrine to ListingDetailScreen (V-64: stable key → replay
 * dedupes, auth-failure park, queued-for-next-flush). Without a queue the
 * screen falls back to a direct createPlot call.
 */
export function PlotCaptureScreen({
  queue,
  onSaved
}: {
  queue?: OfflineQueue;
  onSaved?: () => void;
}) {
  const client = useApiClient();
  const [name, setName] = useState('');
  const [stateName, setStateName] = useState('');
  const [lga, setLga] = useState('');
  const [hectares, setHectares] = useState('');
  const [soilType, setSoilType] = useState<(typeof SOIL_TYPES)[number]>('unknown');
  const [gps, setGps] = useState<{ lat: number; long: number; accuracyMeters?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Stable per form session: retrying the SAME capture (double-tap,
  // offline retry) replays one logical mutation instead of duplicating it.
  const formIdRef = useRef(`plot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const states = useMemo(() => [...NIGERIAN_STATES].sort(), []);

  const captureGps = useCallback(async () => {
    setError(null);
    try {
      // The browser geolocation API is available in Expo web and test
      // builds; native builds would use expo-location with the same shape.
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          reject(new Error('Geolocation is not available on this device'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15_000
        });
      });
      setGps({
        lat: Number(position.coords.latitude.toFixed(6)),
        long: Number(position.coords.longitude.toFixed(6)),
        accuracyMeters: Math.round(position.coords.accuracy)
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not capture GPS coordinates');
    }
  }, []);

  const save = useCallback(async () => {
    setError(null);
    setNotice(null);
    const sizeHectares = Number(hectares);
    if (!name.trim()) {
      setError('Give the plot a name.');
      return;
    }
    if (!stateName || !lga.trim()) {
      setError('Select the state and enter the LGA.');
      return;
    }
    if (!gps) {
      setError('Capture the GPS centroid first (walk to the middle of the plot).');
      return;
    }
    if (!Number.isFinite(sizeHectares) || sizeHectares <= 0) {
      setError('Enter the plot size in hectares (e.g. 1.5).');
      return;
    }
    setBusy(true);
    try {
      const session = await fetchSession(client);
      const input: CreatePlotInput = {
        name: name.trim(),
        state: stateName,
        lga: lga.trim(),
        centroidLat: gps.lat,
        centroidLong: gps.long,
        sizeHectares,
        soilType,
        accuracyMeters: gps.accuracyMeters,
        clientId: formIdRef.current
      };
      const idempotencyKey = `plot.created:${session.data.user.id}:${formIdRef.current}`;
      if (queue) {
        // Offline-first: enqueue, then flush (same doctrine as orders).
        await queue.enqueue({
          kind: 'farms.plot.created',
          method: 'POST',
          path: '/farms/plots',
          payload: input,
          idempotencyKey,
          chainKey: `plot_form:${formIdRef.current}`
        });
        await queue.flush((request) =>
          client.apiFetch(request.path, {
            method: request.method,
            body: request.payload,
            idempotencyKey: request.idempotencyKey
          })
        );
        const stillPending = (await queue.pending()).some(
          (entry) => entry.idempotencyKey === idempotencyKey
        );
        if (stillPending) {
          setNotice('Saved offline — the plot will sync when you are back online.');
          setName('');
          setHectares('');
          setLga('');
          onSaved?.();
          return;
        }
      } else {
        await createPlot(client, input, { idempotencyKey });
      }
      Alert.alert('Plot saved', `${input.name} (${sizeHectares} ha) is on your farm record.`);
      setName('');
      setHectares('');
      setLga('');
      onSaved?.();
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : 'Could not save the plot');
    } finally {
      setBusy(false);
    }
  }, [client, queue, name, stateName, lga, hectares, soilType, gps, onSaved]);

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Card>
        <CardTitle>Capture a plot</CardTitle>
        <Muted>
          Walk to the middle of the field, capture the GPS point, and save. The boundary can be
          added later from the web app.
        </Muted>
        {error ? <ErrorNotice message={error} /> : null}
        {notice ? (
          <View style={uiStyles.notice}>
            <Text style={uiStyles.noticeText}>{notice}</Text>
          </View>
        ) : null}
        <Field label="Plot name">
          <TextInput
            style={uiStyles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Back-of-house maize plot"
            accessibilityLabel="Plot name"
          />
        </Field>
        <Field label="State">
          <TextInput
            style={uiStyles.input}
            value={stateName}
            onChangeText={setStateName}
            placeholder={`e.g. ${states[0] ?? 'Kaduna'}`}
            accessibilityLabel="State"
          />
        </Field>
        <Field label="LGA">
          <TextInput
            style={uiStyles.input}
            value={lga}
            onChangeText={setLga}
            placeholder="e.g. Zaria"
            accessibilityLabel="LGA"
          />
        </Field>
        <Field label="Size (hectares)">
          <TextInput
            style={uiStyles.input}
            value={hectares}
            onChangeText={setHectares}
            placeholder="e.g. 1.5"
            keyboardType="decimal-pad"
            accessibilityLabel="Size in hectares"
          />
        </Field>
        <Field label="Soil type">
          <View style={styles.soilRow}>
            {SOIL_TYPES.map((soil) => (
              <Text
                key={soil}
                style={[styles.soilChip, soilType === soil ? styles.soilChipActive : null]}
                onPress={() => setSoilType(soil)}
                accessibilityRole="button"
                accessibilityState={{ selected: soilType === soil }}
              >
                {soil}
              </Text>
            ))}
          </View>
        </Field>
        <View style={styles.gpsBox}>
          {gps ? (
            <Muted>
              GPS: {gps.lat}, {gps.long}
              {gps.accuracyMeters !== undefined ? ` (±${gps.accuracyMeters} m)` : ''}
            </Muted>
          ) : (
            <Muted>No GPS point captured yet.</Muted>
          )}
          <PrimaryButton label="Capture GPS point" onPress={() => void captureGps()} />
        </View>
        <PrimaryButton
          label={busy ? 'Saving…' : queue ? 'Save plot' : 'Save plot (online only)'}
          onPress={() => void save()}
          disabled={busy}
        />
      </Card>
    </ScrollView>
  );
}

export function createPlotCaptureQueue(): OfflineQueue {
  return createOfflineQueue(createInMemoryStorage());
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  soilRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  soilChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#eceae4',
    color: '#333',
    fontSize: 13
  },
  soilChipActive: { backgroundColor: '#14532d', color: '#ffffff' },
  gpsBox: { gap: 8, marginVertical: 12 }
});
