/**
 * Plot capture GPS UX + mutation-key tests (audit P0-2/P2-15/P2-17):
 * permission-denied guidance, poor-accuracy warnings, and a clientMutationId
 * that covers every editable field so legitimate edits are not deduped
 * away. Plot writes route through the record-level sync outbox
 * (W-SYNCWRITE) — the keys below are the outbox entries' clientMutationIds.
 */
import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { LocationPermissionDeniedError } from '../src/location/location-service';
import { createInMemoryStorage } from '../src/offline/queue';
import {
  PlotCaptureScreen,
  type LocationService
} from '../src/screens/PlotCaptureScreen';
import { createSyncStore } from '../src/sync/store';
import { createApiSyncTransport } from '../src/sync/transport';

/* ------------------------------ helpers --------------------------------- */

function flattenText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

function screenText(root: ReactTestInstance): string {
  return root
    .findAllByType('rn-text' as never)
    .map((node) => flattenText((node as { props: { children?: unknown } }).props.children))
    .join('\n');
}

function pressByLabel(root: ReactTestInstance, label: string): void {
  const target = root
    .findAllByType('rn-pressable' as never)
    .find((node) => flattenText(node).includes(label));
  if (!target) throw new Error(`No pressable labelled "${label}"`);
  (target.props as { onPress?: () => void }).onPress?.();
}

function setInputAt(root: ReactTestInstance, index: number, value: string): void {
  const inputs = root.findAllByType('rn-text-input' as never);
  const target = inputs[index];
  if (!target) throw new Error(`No text input at index ${index}`);
  (target.props as { onChangeText?: (text: string) => void }).onChangeText?.(value);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function interact(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
  });
  await flush();
}

/** Always-offline client: saves stay queued so we can inspect the keys. */
function offlineClient() {
  return createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
  });
}

async function renderCapture(ui: ReactNode): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ApiProvider client={offlineClient()}>{ui}</ApiProvider>);
  });
  await flush();
  return renderer!;
}

const goodGps: LocationService = {
  getCurrentPoint: () => Promise.resolve({ lat: 11.0855, long: 7.7199, accuracyMeters: 6 })
};

/* -------------------------------- tests --------------------------------- */

describe('PlotCaptureScreen GPS UX (P0-2/P2-15)', () => {
  it('shows re-ask guidance when location permission is denied (canAskAgain)', async () => {
    const denied: LocationService = {
      getCurrentPoint: () => Promise.reject(new LocationPermissionDeniedError(true))
    };
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={denied} />
    );

    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    const text = screenText(renderer.root);
    expect(text).toContain('Location permission needed');
    expect(text).toContain('Allow');
    expect(text).not.toContain('Settings → Apps');
  });

  it('points to device Settings when permission is permanently denied', async () => {
    const denied: LocationService = {
      getCurrentPoint: () => Promise.reject(new LocationPermissionDeniedError(false))
    };
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={denied} />
    );

    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    const text = screenText(renderer.root);
    expect(text).toContain('Location permission needed');
    expect(text).toContain('Settings → Apps → AgricPlatform → Permissions');
  });

  it('warns on a poor-accuracy fix and clears the warning on a good one', async () => {
    let accuracy = 300;
    const gps: LocationService = {
      getCurrentPoint: () => Promise.resolve({ lat: 11.0855, long: 7.7199, accuracyMeters: accuracy })
    };
    const renderer = await renderCapture(<PlotCaptureScreen state="Kano" locationService={gps} />);

    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    let text = screenText(renderer.root);
    expect(text).toContain('Low GPS accuracy');
    expect(text).toContain('±300 m');
    // The honest accuracy is still displayed with the captured point.
    expect(text).toContain('11.08550, 7.71990');

    accuracy = 8;
    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    text = screenText(renderer.root);
    expect(text).not.toContain('Low GPS accuracy');
  });

  it('shows the accuracy threshold feedback for boundary points too', async () => {
    const coarse: LocationService = {
      getCurrentPoint: () =>
        Promise.resolve({ lat: 11.086, long: 7.72, accuracyMeters: 120 })
    };
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={coarse} />
    );
    await interact(() => pressByLabel(renderer.root, 'Add boundary point'));
    const text = screenText(renderer.root);
    expect(text).toContain('Low GPS accuracy');
    expect(text).toContain('Boundary (1 points)');
  });
});

describe('PlotCaptureScreen clientMutationId (P2-17)', () => {
  /** Offline sync store: pushes fail, outbox entries stay queued. */
  function offlineStore() {
    return createSyncStore({
      storage: createInMemoryStorage(),
      transport: createApiSyncTransport(offlineClient())
    });
  }

  it('does NOT dedupe a legitimate edit (same plot, corrected LGA)', async () => {
    const store = offlineStore();
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={goodGps} store={store} />
    );

    // First capture (offline → stays in the outbox).
    await interact(() => setInputAt(renderer.root, 0, 'Zaria North Plot'));
    await interact(() => setInputAt(renderer.root, 1, 'Zaria'));
    await interact(() => setInputAt(renderer.root, 2, '2.5'));
    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));
    expect(store.getOutbox()).toHaveLength(1);

    // Correct the LGA and save again — a DIFFERENT logical mutation that
    // must survive as its own outbox entry.
    await interact(() => setInputAt(renderer.root, 1, 'Sabon Gari'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    const outbox = store.getOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox[0].clientMutationId).toContain('Zaria');
    expect(outbox[1].clientMutationId).toContain('Sabon Gari');
    expect(outbox[0].clientMutationId).not.toBe(outbox[1].clientMutationId);
    expect(outbox[0].entityId).not.toBe(outbox[1].entityId);
  });

  it('still dedupes an exact double-submit (same fields → same mutation)', async () => {
    const store = offlineStore();
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={goodGps} store={store} />
    );

    await interact(() => setInputAt(renderer.root, 0, 'Zaria North Plot'));
    await interact(() => setInputAt(renderer.root, 1, 'Zaria'));
    await interact(() => setInputAt(renderer.root, 2, '2.5'));
    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    expect(store.getOutbox()).toHaveLength(1);
  });
});
