/**
 * Plot capture GPS UX + idempotency tests (audit P0-2/P2-15/P2-17):
 * permission-denied guidance, poor-accuracy warnings, and an idempotency
 * key that covers every editable field so legitimate edits are not deduped
 * away.
 */
import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { LocationPermissionDeniedError } from '../src/location/location-service';
import { createInMemoryStorage, createOfflineQueue } from '../src/offline/queue';
import {
  PlotCaptureScreen,
  type LocationService
} from '../src/screens/PlotCaptureScreen';

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

describe('PlotCaptureScreen idempotency key (P2-17)', () => {
  it('does NOT dedupe a legitimate edit (same plot, corrected LGA)', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={goodGps} queue={queue} />
    );

    // First capture (offline → stays queued).
    await interact(() => setInputAt(renderer.root, 0, 'Zaria North Plot'));
    await interact(() => setInputAt(renderer.root, 1, 'Zaria'));
    await interact(() => setInputAt(renderer.root, 2, '2.5'));
    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));
    expect(await queue.pending()).toHaveLength(1);

    // Correct the LGA and save again — a DIFFERENT logical mutation that
    // must survive as its own queue entry.
    await interact(() => setInputAt(renderer.root, 1, 'Sabon Gari'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    const pending = await queue.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0].idempotencyKey).toContain('Zaria');
    expect(pending[1].idempotencyKey).toContain('Sabon Gari');
    expect(pending[0].idempotencyKey).not.toBe(pending[1].idempotencyKey);
  });

  it('still dedupes an exact double-submit (same fields → same key)', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await renderCapture(
      <PlotCaptureScreen state="Kano" locationService={goodGps} queue={queue} />
    );

    await interact(() => setInputAt(renderer.root, 0, 'Zaria North Plot'));
    await interact(() => setInputAt(renderer.root, 1, 'Zaria'));
    await interact(() => setInputAt(renderer.root, 2, '2.5'));
    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    expect(await queue.pending()).toHaveLength(1);
  });
});
