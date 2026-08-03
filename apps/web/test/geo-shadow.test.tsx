import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { GeoShadowPanel, GeoShadowRecomputeButton } from '@/components/geo-shadow-panel';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const SHADOW_STUB = {
  applicationId: 'cla-1',
  factorScore: 81,
  status: 'computed',
  breakdown: {
    plotVerification: 25,
    areaPlausibility: 15,
    floodRisk: 16,
    cropHealth: 15,
    dataFreshness: 10
  },
  basis: { flood: 'stub', crop: 'stub' },
  inputFingerprint: 'deadbeef',
  computedAt: '2026-03-01T00:00:00.000Z'
};

const SHADOW_LIVE = {
  ...SHADOW_STUB,
  basis: { flood: 'live', crop: 'live' }
};

/** Routes fetch by URL to the geo-shadow endpoints. */
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn().mockImplementation(handler);
}

function shadowRoute(body: unknown, status = 200) {
  return mockFetch((url: string) => {
    if (url.includes('/credit/applications/') && url.includes('/geo-shadow')) {
      return jsonResponse({ data: body }, status);
    }
    return jsonResponse({}, 404);
  });
}

function renderPanel(applicationId = 'cla-1') {
  return render(
    <I18nProvider>
      <GeoShadowPanel applicationId={applicationId} />
    </I18nProvider>
  );
}

describe('GeoShadowPanel', () => {
  beforeEach(() => {
    clearApiCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the shadow banner and factor score with stub basis badges', async () => {
    vi.stubGlobal('fetch', shadowRoute(SHADOW_STUB));
    renderPanel();
    await waitFor(() => screen.getByTestId('geo-shadow-body'));
    expect(screen.getByText('Shadow mode — not used in decisions')).toBeTruthy();
    expect(screen.getByText('81 out of 100')).toBeTruthy();
    expect(screen.getByText('Flood data: STUB')).toBeTruthy();
    expect(screen.getByText('Crop data: STUB')).toBeTruthy();
  });

  it('renders the component breakdown rows', async () => {
    vi.stubGlobal('fetch', shadowRoute(SHADOW_STUB));
    renderPanel();
    await waitFor(() => screen.getByTestId('geo-shadow-body'));
    expect(screen.getByText('Plot verified')).toBeTruthy();
    expect(screen.getByText('Area plausibility')).toBeTruthy();
    expect(screen.getByText('Flood risk')).toBeTruthy();
    expect(screen.getByText('Crop health')).toBeTruthy();
    expect(screen.getByText('Data freshness')).toBeTruthy();
    expect(screen.getByText('16')).toBeTruthy();
  });

  it('shows LIVE basis badges when both inputs are live inference', async () => {
    vi.stubGlobal('fetch', shadowRoute(SHADOW_LIVE));
    renderPanel();
    await waitFor(() => screen.getByTestId('geo-shadow-body'));
    expect(screen.getByText('Flood data: LIVE')).toBeTruthy();
    expect(screen.getByText('Crop data: LIVE')).toBeTruthy();
  });

  it('shows the honest unavailable state on 503 (fail-closed, no fabricated score)', async () => {
    vi.stubGlobal('fetch', shadowRoute({ message: 'down' }, 503));
    renderPanel();
    await waitFor(() =>
      screen.getByText('Geo verification is unavailable right now — no score was recorded.')
    );
    expect(screen.queryByTestId('geo-shadow-body')).toBeNull();
    expect(screen.getByText('Shadow mode — not used in decisions')).toBeTruthy();
  });

  it('shows the disabled state on 404 (GEO_CREDIT_MODE=off)', async () => {
    vi.stubGlobal('fetch', shadowRoute({ message: 'off' }, 404));
    renderPanel();
    await waitFor(() =>
      screen.getByText('Geo verification is disabled on this deployment.')
    );
  });

  it('calls the geo-shadow endpoint for the given application', async () => {
    const fetchMock = shadowRoute(SHADOW_STUB);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel('cla-99');
    await waitFor(() => screen.getByTestId('geo-shadow-body'));
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/credit/applications/cla-99/geo-shadow'))).toBe(true);
  });
});

describe('GeoShadowRecomputeButton', () => {
  beforeEach(() => {
    clearApiCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the recompute and reports the idempotency breakdown', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url: string, init?: RequestInit) => {
        if (url.includes('/credit/geo-shadow/recompute') && init?.method === 'POST') {
          return jsonResponse({
            data: {
              mode: 'shadow',
              applications: 3,
              recomputed: 2,
              skipped: 1,
              unavailable: 0,
              failed: 0,
              computedAt: '2026-03-01T00:00:00.000Z'
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );
    render(
      <I18nProvider>
        <GeoShadowRecomputeButton />
      </I18nProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recompute shadow scores' }));
    await waitFor(() =>
      screen.getByText('Recompute finished — 2 updated, 1 unchanged, 0 unavailable.')
    );
  });

  it('surfaces a failure notice when the recompute errors', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonResponse({ message: 'forbidden' }, 403)));
    render(
      <I18nProvider>
        <GeoShadowRecomputeButton />
      </I18nProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recompute shadow scores' }));
    await waitFor(() => screen.getByText('Shadow recompute failed'));
  });
});
