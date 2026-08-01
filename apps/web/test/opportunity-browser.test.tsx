import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { clearApiCache } from '@/lib/api/hooks';
import { OpportunityBrowser } from '@/components/opportunity-browser';

const OPPORTUNITY = {
  id: 'opp-test-grant',
  title: 'Test Irrigation Grant',
  type: 'grant',
  description: 'A grant for test farms.',
  states: ['Kano'],
  valueChains: ['Vegetables'],
  eligibility: ['Verified profile'],
  deadline: '2026-12-01T00:00:00.000Z',
  isActive: true
};

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

describe('OpportunityBrowser (wired smoke test)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/api/v1/opportunities')) {
        return jsonResponse({ data: [OPPORTUNITY], total: 1, page: 1, pageSize: 100 });
      }
      if (parsed.pathname.endsWith('/api/v1/applications')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders opportunities from the API and an apply action', async () => {
    render(
      <AppProvider>
        <OpportunityBrowser />
      </AppProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Test Irrigation Grant')).toBeTruthy();
    });

    expect(screen.getByRole('status').textContent).toContain('1 opportunity found');
    // Per-card accessible name disambiguates the identical Apply buttons.
    expect(
      screen.getByRole('button', { name: 'Apply for Test Irrigation Grant' })
    ).toBeTruthy();

    // The list endpoint was called through the typed client (GET, no key).
    const listCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/v1/opportunities')
    );
    expect(listCall).toBeTruthy();
    expect((listCall![1] as { headers: Record<string, string> }).headers['x-user-id']).toBe(
      'user-adamu'
    );
  });

  it('shows the offline fallback with a notice when the API is unreachable', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    render(
      <AppProvider>
        <OpportunityBrowser />
      </AppProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/showing saved reference data/i)).toBeTruthy();
    });
  });
});
