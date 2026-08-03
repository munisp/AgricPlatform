import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { PartnerImpactCard, PartnerProgrammes } from '@/components/partner-live';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function errorEnvelope(statusCode: number, error: string, message: string) {
  return { statusCode, error, message, path: '/api/v1/partner/x', timestamp: new Date().toISOString() };
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

describe('Partner hub authorization states (G20)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('403 shows an honest partner-access empty state, not fixture stats', async () => {
    fetchMock.mockImplementation(() => jsonResponse(errorEnvelope(403, 'Forbidden', 'Requires partner role'), 403));
    renderWithProviders(<PartnerProgrammes />);
    expect(await screen.findByText(/Partner access required/i)).toBeTruthy();
    // No fixture stats and no offline-catalogue label.
    expect(screen.queryByText(/Completion rate/i)).toBeNull();
    expect(screen.queryByText(/showing programme catalogue copy/i)).toBeNull();
  });

  it('401 on the impact report shows the same honest empty state', async () => {
    fetchMock.mockImplementation(() => jsonResponse(errorEnvelope(401, 'Unauthorized', 'Authentication required'), 401));
    renderWithProviders(<PartnerImpactCard />);
    expect(await screen.findByText(/Partner access required/i)).toBeTruthy();
    expect(screen.queryByText(/Impact report unavailable/i)).toBeNull();
  });

  it('genuine network failure keeps the labelled fixture fallback', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    renderWithProviders(<PartnerProgrammes />);
    expect(await screen.findByText(/showing programme catalogue copy/i)).toBeTruthy();
    // Fixture stats are present in the labelled fallback.
    await waitFor(() => {
      expect(screen.getAllByText(/Completion rate/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Partner access required/i)).toBeNull();
  });
});
