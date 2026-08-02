import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { AnalyticsExportButtons } from '@/components/analytics-export';

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

describe('Analytics export buttons', () => {
  const fetchMock = vi.fn();
  let createdUrls: string[];
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    createdUrls = [];
    clicked = [];
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        createdUrls.push(`blob:mock-${createdUrls.length}`);
        return createdUrls[createdUrls.length - 1];
      }),
      revokeObjectURL: vi.fn()
    }));
    // Capture the download click without navigating jsdom.
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this);
    };
    // Restore after each test via prototype reset in afterEach.
    (HTMLAnchorElement.prototype as unknown as { __originalClick: unknown }).__originalClick =
      originalClick;
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    const proto = HTMLAnchorElement.prototype as unknown as { __originalClick: unknown };
    if (proto.__originalClick) {
      HTMLAnchorElement.prototype.click = proto.__originalClick as () => void;
      delete proto.__originalClick;
    }
  });

  it('exports CSV: calls the export endpoint and triggers a file download', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response('metric,value\nmembers,100\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv' }
        })
      )
    );

    renderWithProviders(<AnalyticsExportButtons />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => {
      expect(screen.getByText('downloaded analytics-export.csv')).toBeTruthy();
    });

    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/api/v1/analytics/export');
    expect(String(call[0])).toContain('format=csv');
    expect(createdUrls.length).toBe(1);
    expect(clicked.length).toBe(1);
    expect(clicked[0].download).toBe('analytics-export.csv');
  });

  it('exports PDF with format=pdf', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' }
        })
      )
    );

    renderWithProviders(<AnalyticsExportButtons />);
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => {
      expect(screen.getByText('downloaded analytics-export.pdf')).toBeTruthy();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('format=pdf');
  });

  it('shows an explicit error with retry when the export fails', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            statusCode: 500,
            error: 'Internal Server Error',
            message: 'Export exploded',
            path: '/analytics/export',
            timestamp: new Date().toISOString()
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    renderWithProviders(<AnalyticsExportButtons />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.getByRole('alert').textContent).toContain('Export exploded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(createdUrls.length).toBe(0);
  });
});
