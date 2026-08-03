import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Animal } from '@agric-platform/shared';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  LivestockSummaryCard,
  summariseLivestock
} from '@/components/livestock-dashboard-widget';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const cattle: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: 'user-farmer',
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z'
};

const goat: Animal = { ...cattle, id: 'NG-CAP-KD-000002', species: 'goat' };
const sold: Animal = { ...cattle, id: 'NG-BOV-KD-000003', status: 'sold' };

const DUE_ITEMS = [
  {
    animalId: cattle.id,
    vaccine: 'FMD',
    dueDate: '2026-06-01T00:00:00.000Z',
    daysOverdue: 12,
    status: 'overdue'
  },
  {
    animalId: goat.id,
    vaccine: 'PPR',
    dueDate: '2026-06-20T00:00:00.000Z',
    daysUntilDue: 7,
    status: 'due'
  },
  {
    animalId: cattle.id,
    vaccine: 'Anthrax',
    dueDate: '2026-12-01T00:00:00.000Z',
    daysUntilDue: 170,
    status: 'upcoming'
  }
];

function router(dueStatus = 200) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/api/v1/livestock-health/vaccinations/due')) {
      return dueStatus === 200
        ? jsonResponse({ data: DUE_ITEMS })
        : jsonResponse({ message: 'forbidden' }, dueStatus);
    }
    if (path.endsWith('/api/v1/livestock-health/recalls')) {
      // Farmers cannot list recalls — the widget maps 403 to a neutral chip.
      return jsonResponse({ message: 'forbidden' }, 403);
    }
    return jsonResponse({ data: null });
  };
}

describe('summariseLivestock — due vaccinations', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('counts due + overdue vaccinations as pending health tasks (upcoming excluded)', async () => {
    fetchMock.mockImplementation(router());
    const summary = await summariseLivestock([cattle, goat, sold]);
    expect(summary.total).toBe(2); // sold animal excluded
    expect(summary.bySpecies).toEqual([
      { species: 'cattle', count: 1 },
      { species: 'goat', count: 1 }
    ]);
    expect(summary.pendingHealthTasks).toBe(2);
    expect(summary.overdueHealthTasks).toBe(1);
    // Recall listing is regulator/admin-only: 403 maps to null, not an error.
    expect(summary.openRecalls).toBeNull();
  });

  it('requests the due endpoint with a 30-day lookahead window', async () => {
    fetchMock.mockImplementation(router());
    await summariseLivestock([cattle]);
    const dueCall = fetchMock.mock.calls.find(([url]) =>
      new URL(String(url)).pathname.endsWith('/api/v1/livestock-health/vaccinations/due')
    );
    expect(new URL(String(dueCall![0])).searchParams.get('days')).toBe('30');
  });

  it('leaves pending counts at zero when the due endpoint is unavailable', async () => {
    fetchMock.mockImplementation(router(500));
    const summary = await summariseLivestock([cattle]);
    expect(summary.pendingHealthTasks).toBe(0);
    expect(summary.overdueHealthTasks).toBe(0);
  });
});

describe('LivestockSummaryCard', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      'agric.session',
      JSON.stringify({
        userId: 'user-farmer',
        displayName: 'farmer',
        role: 'farmer',
        isDevPreview: true
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/api/v1/livestock/animals/mine')) {
        return jsonResponse({ data: [cattle, goat] });
      }
      return router()(input);
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the pending health tasks badge with the overdue count', async () => {
    render(
      <AppProvider>
        <I18nProvider>
          <LivestockSummaryCard />
        </I18nProvider>
      </AppProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/2 pending health tasks/)).toBeTruthy();
    });
    expect(screen.getByText(/\(1 overdue\)/)).toBeTruthy();
    expect(screen.getByLabelText('2 vaccinations due or overdue')).toBeTruthy();
    expect(screen.getByText(/recalls: regulator only/)).toBeTruthy();
  });
});
