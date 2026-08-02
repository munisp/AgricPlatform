import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  ExternalLinksTable,
  FarmRecordsPanel,
  ImportBatchesPanel
} from '@/components/federation-admin';

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

const LINK = {
  id: 'link-1',
  userId: 'user-adamu',
  system: 'farmos',
  externalId: 'farm-42',
  consentAt: '2026-01-10T00:00:00.000Z',
  createdAt: '2026-01-10T00:00:00.000Z'
};

const FARM_RECORD = {
  id: 'fr-1',
  linkId: 'link-1',
  recordType: 'harvest',
  externalId: 'ext-9',
  payload: { crop: 'maize' },
  source: 'farmos',
  observedAt: '2026-02-01T00:00:00.000Z',
  syncedAt: '2026-02-02T00:00:00.000Z'
};

const BATCH = {
  id: 'batch-1',
  sourceSystem: 'odk',
  donorSource: 'giz-southwest',
  status: 'STAGED',
  recordCount: 2,
  createdBy: 'user-admin',
  createdAt: '2026-02-20T00:00:00.000Z'
};

const RECORDS = [
  {
    id: 'rec-1',
    batchId: 'batch-1',
    phoneHash: 'abc123456789',
    payload: { fullName: 'Adaeze Obi' },
    status: 'STAGED',
    donorSource: 'giz-southwest',
    consentDate: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-02-20T00:00:00.000Z'
  },
  {
    id: 'rec-2',
    batchId: 'batch-1',
    payload: { rejectionReason: 'missing or invalid consentDate' },
    status: 'REJECTED',
    donorSource: 'giz-southwest',
    consentDate: '',
    createdAt: '2026-02-20T00:00:00.000Z'
  }
];

describe('Federation admin', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      if (path.endsWith('/api/v1/integrations/federation/links') && method === 'GET') {
        return jsonResponse({ data: [LINK] });
      }
      if (path.endsWith(`/api/v1/integrations/federation/links/${LINK.id}`) && method === 'DELETE') {
        return jsonResponse({ data: { ...LINK, revokedAt: '2026-03-01T00:00:00.000Z' } });
      }
      if (path.endsWith('/api/v1/integrations/federation/farm-records') && method === 'GET') {
        return jsonResponse({ data: [FARM_RECORD] });
      }
      if (path.endsWith('/api/v1/integrations/federation/farm-records/sync') && method === 'POST') {
        return jsonResponse({ data: { syncedLinks: 1, inserted: 2 } });
      }
      if (path.endsWith(`/api/v1/integrations/federation/import/batches/${BATCH.id}`) && method === 'GET') {
        return jsonResponse({ data: { batch: BATCH, records: RECORDS } });
      }
      if (
        path.endsWith(`/api/v1/integrations/federation/import/batches/${BATCH.id}/confirm`) &&
        method === 'POST'
      ) {
        return jsonResponse({
          data: { batch: { ...BATCH, status: 'CONFIRMED', confirmedAt: '2026-03-01T00:00:00.000Z' }, merged: 1, rejected: 1 }
        });
      }
      if (path.endsWith('/api/v1/integrations/federation/import/pull') && method === 'POST') {
        return jsonResponse({ data: { batchIds: [BATCH.id] } });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('lists external account links with consent dates', async () => {
    renderWithProviders(<ExternalLinksTable />);
    await waitFor(() => {
      expect(screen.getByText('farmos')).toBeTruthy();
    });
    expect(screen.getByText('farm-42')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
  });

  it('revokes a link only after the inline confirm', async () => {
    renderWithProviders(<ExternalLinksTable />);
    await waitFor(() => {
      expect(screen.getByText('farmos')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Revoke this link?')).toBeTruthy();
    // No DELETE before confirming.
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => {
      expect(screen.getByText('revoked')).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE');
    expect(call).toBeTruthy();
  });

  it('triggers a farm-record sync and shows recent records', async () => {
    renderWithProviders(<FarmRecordsPanel />);
    await waitFor(() => {
      expect(screen.getByText('ext-9')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => {
      expect(screen.getByText(/link\(s\) checked,/)).toBeTruthy();
    });
  });

  it('opens a batch by id, shows staged records with reject reasons and confirms the merge', async () => {
    renderWithProviders(<ImportBatchesPanel />);

    fireEvent.change(screen.getByLabelText('Batch ID'), { target: { value: 'batch-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open batch' }));

    await waitFor(() => {
      expect(screen.getByText(/Batch batch-1/)).toBeTruthy();
    });
    expect(screen.getByText(/Adaeze Obi/)).toBeTruthy();
    expect(screen.getByText(/missing or invalid consentDate/)).toBeTruthy();
    expect(screen.getAllByText('staged').length).toBeGreaterThan(0);
    expect(screen.getByText('rejected')).toBeTruthy();

    // Two-step confirm, then the summary dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Review & merge' }));
    expect(screen.getByText(/Merge 1 staged record\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
    expect(screen.getByText('Import merged')).toBeTruthy();
    expect(screen.getByText('Records merged')).toBeTruthy();
    expect(screen.getByText('Records rejected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pulls submissions and remembers the new batch on this device', async () => {
    renderWithProviders(<ImportBatchesPanel />);
    fireEvent.change(screen.getByLabelText('Donor source'), { target: { value: 'giz-southwest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pull submissions' }));

    await waitFor(() => {
      expect(screen.getByText(/1 batch\(es\) staged: batch-1/)).toBeTruthy();
    });
    // Pulled batch auto-opens its detail.
    await waitFor(() => {
      expect(screen.getByText(/Batch batch-1/)).toBeTruthy();
    });
    expect(window.localStorage.getItem('agric.federation.recentBatchIds')).toContain('batch-1');
  });
});
