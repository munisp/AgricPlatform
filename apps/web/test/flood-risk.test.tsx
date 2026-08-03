import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { FloodRiskCard } from '@/components/flood-risk-card';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const STUB_STATUS = {
  driver: 'stub',
  configured: true,
  healthy: true,
  liveInference: false,
  detail: 'Stub driver: deterministic simulated fixture.'
};

const LIVE_STATUS = {
  driver: 'http',
  configured: true,
  healthy: true,
  liveInference: true,
  detail: 'flood-ml sidecar reachable; Sentinel Hub credentials configured.'
};

const ASSESSMENT = {
  floodDetected: true,
  severity: 'moderate',
  floodPercentage: 7.5,
  floodAreaKm2: 1.88,
  confidence: 0.5,
  source: 'stub-fixture (simulated — not a live satellite assessment)',
  assessedAt: '2026-01-01T00:00:00.000Z',
  message: 'Simulated flood risk',
  recommendedActions: [],
  assessedLocation: { latitude: 11.0855, longitude: 7.7199 },
  driver: 'stub',
  plot: { id: 'plot-1', name: 'Zaria North Plot', distanceKm: 0 }
};

/** Routes fetch by URL: status endpoint and assessment endpoint. */
function mockFetch({ status, assessment }: { status: unknown; assessment?: unknown }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/geo-intel/flood-risk/status')) {
      return jsonResponse({ data: status });
    }
    if (url.includes('/geo-intel/flood-risk')) {
      return assessment ? jsonResponse({ data: assessment }) : jsonResponse({ data: {} }, 500);
    }
    return jsonResponse({}, 404);
  });
}

function renderCard() {
  return render(
    <I18nProvider>
      <FloodRiskCard />
    </I18nProvider>
  );
}

describe('FloodRiskCard', () => {
  beforeEach(() => {
    clearApiCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stub driver: renders the assessment badged honestly as demo data', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: STUB_STATUS, assessment: ASSESSMENT }));
    renderCard();
    await waitFor(() => expect(screen.getAllByText(/demo data/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/Risk level: moderate/)).toBeTruthy();
    expect(screen.getByText(/Zaria North Plot/)).toBeTruthy();
    expect(screen.getByText(/not enabled on this deployment/i)).toBeTruthy();
    expect(screen.getByText(/NiMet advisories/)).toBeTruthy();
  });

  it('http driver unreachable: renders the honest not-set-up empty state', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: {
          driver: 'http',
          configured: true,
          healthy: false,
          liveInference: false,
          detail: 'flood-ml sidecar unreachable at http://flood-ml:8001 (health probe failed).'
        }
      })
    );
    renderCard();
    await waitFor(() => expect(screen.getByText('Flood risk is not set up')).toBeTruthy());
    expect(screen.getByText(/Ask your administrator/)).toBeTruthy();
    expect(screen.getByText(/unreachable/)).toBeTruthy();
    // Never fetches an assessment in the not-configured state.
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string
    );
    expect(calls.some((u) => u.includes('/geo-intel/flood-risk?'))).toBe(false);
    expect(
      calls.filter((u) => u.endsWith('/geo-intel/flood-risk')).length
    ).toBe(0);
  });

  it('http driver without FLOOD_ML_URL: not-configured state with the config detail', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: {
          driver: 'http',
          configured: false,
          healthy: false,
          liveInference: false,
          detail: 'FLOOD_ML_DRIVER=http is set but FLOOD_ML_URL is missing.'
        }
      })
    );
    renderCard();
    await waitFor(() => expect(screen.getByText('Flood risk is not set up')).toBeTruthy());
    expect(screen.getByText(/FLOOD_ML_URL is missing/)).toBeTruthy();
  });

  it('live sidecar: renders the model estimate badge and keeps the caveat', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: LIVE_STATUS,
        assessment: { ...ASSESSMENT, driver: 'http', source: 'flood-ml sidecar' }
      })
    );
    renderCard();
    await waitFor(() => expect(screen.getByText(/model estimate/i)).toBeTruthy());
    expect(screen.queryByText(/demo data/i)).toBeNull();
    expect(screen.getByText(/NiMet advisories/)).toBeTruthy();
  });

  it('shows the mapped error state when the status request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    renderCard();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
