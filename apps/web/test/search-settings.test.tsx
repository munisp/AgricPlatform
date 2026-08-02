import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { SearchClient } from '@/components/search-client';
import { DataUsageSection, OfflinePackSection } from '@/components/settings-live';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

describe('Search depth', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/api/v1/search/trending')) {
        return jsonResponse({
          data: [
            { query: 'cassava price', score: 12.5, occurrences: 40 },
            { query: 'tractor hire', score: 8.2, occurrences: 21 }
          ]
        });
      }
      if (parsed.pathname.endsWith('/api/v1/search/related')) {
        return jsonResponse({
          data: [
            {
              type: 'course',
              id: 'course-related',
              title: 'Related: Cassava agronomy',
              summary: 'Grow better cassava.',
              score: 0.9
            }
          ]
        });
      }
      if (parsed.pathname.endsWith('/api/v1/search')) {
        return jsonResponse({
          data: [
            {
              type: 'listing',
              id: 'listing-1',
              title: 'Cassava tubers — 2 tonnes',
              summary: 'Fresh tubers in Kano.',
              score: 1.4
            }
          ]
        });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('shows the trending strip and applies a trending query on click', async () => {
    renderWithProviders(<SearchClient />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Search for trending topic cassava price' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search for trending topic cassava price' }));
    await waitFor(() => {
      expect((screen.getByLabelText('Search the platform') as HTMLInputElement).value).toBe(
        'cassava price'
      );
    });
  });

  it('fetches related items when a result detail is expanded', async () => {
    renderWithProviders(<SearchClient />);
    fireEvent.change(screen.getByLabelText('Search the platform'), {
      target: { value: 'cassava' }
    });
    await waitFor(
      () => {
        expect(screen.getByText('Cassava tubers — 2 tonnes')).toBeTruthy();
      },
      { timeout: 3000 }
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Related items for Cassava tubers — 2 tonnes' })
    );
    await waitFor(() => {
      expect(screen.getByText('Related: Cassava agronomy')).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/v1/search/related')
    );
    expect(String(call![0])).toContain('type=listing');
    expect(String(call![0])).toContain('id=listing-1');
  });
});

describe('Settings — data usage and offline pack', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/api/v1/knowledge-resources')) {
        return jsonResponse({
          data: [
            {
              id: 'kr-offline',
              title: 'Offline maize guide',
              body: 'Readable offline.',
              tags: ['maize'],
              language: 'en',
              format: 'article',
              offlineAvailable: true,
              viewCount: 10,
              publishedAt: '2026-01-01T00:00:00.000Z'
            }
          ],
          total: 1,
          page: 1,
          pageSize: 60
        });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('measures session data usage on demand and toggles reduced data mode', async () => {
    renderWithProviders(<DataUsageSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Measure now' }));
    await waitFor(() => {
      expect(screen.getByTestId('data-usage-value').textContent).not.toBe('—');
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /Reduce data usage/ }));
    await waitFor(() => {
      expect(screen.getByText('reduced data mode on')).toBeTruthy();
    });
    expect(window.localStorage.getItem('agric.reduce-data')).toBe('true');
  });

  it('downloads an offline resource via the service worker message channel', async () => {
    const posted: { type: string; urls: string[] }[] = [];
    const postMessage = vi.fn((message: { type: string; urls: string[] }, transfer?: Transferable[]) => {
      posted.push(message);
      // Simulate the SW ack through the transferred MessagePort.
      const port = transfer?.[0] as MessagePort | undefined;
      port?.postMessage({ ok: true, count: message.urls.length });
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage } }
    });

    renderWithProviders(<OfflinePackSection />);
    await waitFor(() => {
      expect(screen.getByText('Offline maize guide')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Download Offline maize guide for offline reading' })
    );
    await waitFor(() => {
      expect(screen.getByText('saved for offline')).toBeTruthy();
    });
    expect(posted[0].type).toBe('CACHE_URLS');
    expect(posted[0].urls[0]).toContain('/api/v1/knowledge-resources/kr-offline');
  });

  it('surfaces a retryable error when the service worker is unavailable', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: null }
    });

    renderWithProviders(<OfflinePackSection />);
    await waitFor(() => {
      expect(screen.getByText('Offline maize guide')).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Download Offline maize guide for offline reading' })
    );
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('service worker is not active');
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
