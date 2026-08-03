import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import type { CreateFarmPlotInput } from '../api/types';
import {
  GOOD_FIX_ACCURACY_METERS,
  LocationPermissionDeniedError,
  type GeoPoint,
  type LocationService
} from '../location/location-service';
import { useSyncStore } from '../sync/context';
import { SYNC_ENTITY_FARM_PLOT } from '../sync/entities';
import type { SyncStore } from '../sync/store';
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

/** A capture the screen has accepted — confirmed by the server or queued. */
export interface SavedPlotSummary {
  /** Client-stable id; becomes the server record id once applied. */
  id: string;
  name: string;
  state: string;
  lga: string;
  sizeHectares: number;
  /** Server version after apply (0 while the capture is still queued). */
  version: number;
  /** True when the server confirmed the capture during this save. */
  synced: boolean;
}

/** FNV-1a 32-bit — deterministic, dependency-free id derivation. */
function fnv1a(value: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Client-stable plot id derived from the mutation key. Deterministic on
 * purpose: a double-submit or an offline replay of the SAME logical capture
 * targets the same record, so server-side idempotency replays the original
 * outcome instead of failing on a mismatched id. Two 32-bit lanes keep
 * accidental collisions negligible at single-device capture volumes.
 */
export function derivedPlotId(clientMutationId: string): string {
  const forward = fnv1a(clientMutationId, 0x811c9dc5);
  const backward = fnv1a(clientMutationId, 0x811c9dc5 ^ 0x9e3779b9);
  return `plot-${forward.toString(36)}${backward.toString(36)}`;
}

/**
 * Plot capture: name/LGA/size form with GPS centroid capture and a
 * walk-the-perimeter boundary point list (≥3 points become a closed GeoJSON
 * Polygon). Writes go through the record-level sync OUTBOX (W-SYNCWRITE —
 * no longer the legacy transport queue): the capture is enqueued with a
 * stable clientMutationId, pushed immediately when online, and flushed by
 * the connectivity sync when the device reconnects. The server applies it
 * exactly once (clientMutationId idempotency), and FarmsScreen picks the
 * confirmed plot up on its next focus refresh / sync pull.
 */
export function PlotCaptureScreen({
  state = 'Kano',
  locationService = unconfiguredLocationService,
  store,
  onSaved
}: {
  state?: string;
  locationService?: LocationService;
  /** Sync store override (tests); defaults to the app-wide provider store. */
  store?: SyncStore;
  onSaved?: (plot: SavedPlotSummary) => void;
}) {
  const ambientStore = useSyncStore();
  const syncStore = store ?? ambientStore;

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
      // Stable mutation key per logical capture: the outbox dedupes on it,
      // so a double-tap or an offline replay cannot create two plots. The
      // key covers EVERY editable field (audit P2-17) — a legitimate edit
      // (e.g. fixing the LGA after a failed send) produces a different key
      // and is not deduped away.
      const clientMutationId = [
        'farms.plot',
        centroid.lat.toFixed(5),
        centroid.long.toFixed(5),
        input.name,
        input.state,
        input.lga,
        input.sizeHectares
      ].join('.');
      const entityId = derivedPlotId(clientMutationId);
      // Record-level outbox (docs/sync-protocol.md §4/§5). baseVersion 0 =
      // "new record"; the server CAS-guards it.
      const entry = await syncStore.enqueue({
        entity: SYNC_ENTITY_FARM_PLOT,
        entityId,
        op: 'upsert',
        payload: { ...input },
        clientMutationId
      });
      // Online: push immediately. Offline: the entry stays durable in the
      // outbox and the connectivity sync flushes it on reconnect.
      await syncStore.pushPending();
      const stillPending = syncStore
        .getOutbox()
        .some((candidate) => candidate.clientMutationId === entry.clientMutationId);
      if (stillPending) {
        setNotice('No connection — the plot is queued and will sync when you are back online.');
        return;
      }
      const confirmed = syncStore
        .getRecords(SYNC_ENTITY_FARM_PLOT)
        .find((record) => record.entityId === entityId);
      if (confirmed && confirmed.version > 0) {
        // Applied — or a conflict the store already resolved server-wins
        // (the confirmed record then carries the server version).
        onSaved?.({
          id: entityId,
          name: input.name,
          state: input.state,
          lga: input.lga,
          sizeHectares: input.sizeHectares,
          version: confirmed.version,
          synced: true
        });
        setNotice('Plot saved.');
        setName('');
        setLga('');
        setSize('');
        setCentroid(null);
        setBoundary([]);
      } else {
        // Permanently rejected by the server (e.g. forbidden) — the outbox
        // dropped the mutation; nothing is saved locally or remotely.
        setError('The server rejected this plot — it was not saved.');
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
