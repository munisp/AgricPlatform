import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { HashBadge, TraceabilityHub } from '@/components/traceability-live';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded — color contrast is
// covered by test/contrast.test.ts against the CSS source.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

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

const LOT = {
  id: 'lot-1',
  ownerUserId: 'user-farmer',
  crop: 'Cocoa',
  harvestWindowStart: '2026-01-01T00:00:00.000Z',
  harvestWindowEnd: '2026-03-01T00:00:00.000Z',
  quantity: 500,
  unit: 'kg',
  status: 'active',
  parentLotIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const EVENT_1 = {
  id: 'evt-1',
  lotId: 'lot-1',
  seq: 0,
  type: 'CREATED',
  actorId: 'user-farmer',
  occurredAt: '2026-02-01T00:00:00.000Z',
  latitude: 11.0855,
  longitude: 7.7199,
  parentLotIds: [],
  prevEventHash: '0'.repeat(64),
  eventHash: 'a'.repeat(64),
  createdAt: '2026-02-01T00:00:00.000Z'
};

const EVENT_2 = {
  ...EVENT_1,
  id: 'evt-2',
  seq: 1,
  type: 'SHIPPED',
  prevEventHash: 'a'.repeat(64),
  eventHash: 'b'.repeat(64)
};

function timelineFor(events: unknown[], valid = true) {
  return {
    lot: LOT,
    events,
    verification: {
      lotId: 'lot-1',
      eventCount: events.length,
      valid,
      events: (events as Array<{ id: string; seq: number; type: string; eventHash: string }>).map(
        (event) => ({
          eventId: event.id,
          lotId: 'lot-1',
          seq: event.seq,
          type: event.type,
          hashValid: valid,
          prevLinkValid: true,
          valid,
          expectedHash: event.eventHash,
          storedHash: event.eventHash
        })
      )
    }
  };
}

const DDS = {
  statementVersion: '1.0',
  generatedAt: '2026-02-10T00:00:00.000Z',
  ddsReference: 'tsh-1',
  operator: {
    status: 'TO_BE_COMPLETED_BY_EXPORTER',
    legalName: null,
    eori: null,
    address: null,
    note: 'placeholder'
  },
  commodity: { description: 'Cocoa', crops: ['Cocoa'] },
  quantity: { value: 500, unit: 'kg' },
  countryOfProduction: 'NG',
  productionPlots: [],
  harvestWindow: { start: LOT.harvestWindowStart, end: LOT.harvestWindowEnd },
  custodySummary: { lotCount: 1, eventCount: 2, eventTypes: ['CREATED', 'SHIPPED'] },
  deforestationRisk: { basis: 'stub', note: 'proxy', assessments: [] },
  chainIntegrity: { verified: true, eventCount: 2, lots: [], verifiedAt: '2026-02-10T00:00:00.000Z' },
  disclaimers: ['a', 'b', 'c']
};

interface RouterState {
  lots: unknown[];
  events: unknown[];
  chainValid: boolean;
  shipmentCreated: boolean;
}

function router(state: RouterState) {
  return (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/traceability/lots') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      state.lots = [...state.lots, { ...LOT, id: 'lot-new', ...body }];
      return jsonResponse({ data: state.lots[state.lots.length - 1] });
    }
    if (path.endsWith('/traceability/lots')) return jsonResponse({ data: state.lots });
    if (path.endsWith('/lots/lot-1/timeline')) {
      return jsonResponse({ data: timelineFor(state.events, state.chainValid) });
    }
    if (path.endsWith('/lots/lot-1/events') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      state.events = [
        ...state.events,
        { ...EVENT_1, id: `evt-${state.events.length + 1}`, seq: state.events.length, ...body }
      ];
      return jsonResponse({ data: state.events[state.events.length - 1] });
    }
    if (path.endsWith('/traceability/shipments') && method === 'POST') {
      state.shipmentCreated = true;
      return jsonResponse({
        data: {
          shipment: {
            id: 'tsh-1',
            creatorId: 'user-farmer',
            creatorKind: 'user',
            status: 'created',
            createdAt: '2026-02-10T00:00:00.000Z',
            updatedAt: '2026-02-10T00:00:00.000Z'
          },
          lots: [LOT]
        }
      });
    }
    if (path.endsWith('/shipments/tsh-1/dds/verify')) {
      return jsonResponse({
        data: {
          shipmentId: 'tsh-1',
          allValid: true,
          eventCount: 2,
          lots: [timelineFor(state.events).verification]
        }
      });
    }
    if (path.endsWith('/shipments/tsh-1/dds')) return jsonResponse({ data: DDS });
    return jsonResponse({ message: 'not found' }, 404);
  };
}

describe('TraceabilityHub (wave-eudr)', () => {
  const fetchMock = vi.fn();
  let state: RouterState;

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    state = { lots: [LOT], events: [EVENT_1, EVENT_2], chainValid: true, shipmentCreated: false };
    fetchMock.mockImplementation(router(state));
    // jsdom lacks the blob URL API used by the DDS download.
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn()
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the lot list from the API', async () => {
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('Commodity lots')).toBeTruthy();
  });

  it('shows the empty state when no lots exist', async () => {
    state.lots = [];
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('No lots yet.')).toBeTruthy());
  });

  it('loads the custody timeline with hash badges and per-event ✓ marks', async () => {
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Custody timeline' }));
    // 'CREATED'/'SHIPPED' also appear as <option>s in the event-type select.
    await waitFor(() => expect(screen.getAllByText('CREATED').length).toBeGreaterThan(0));
    expect(screen.getAllByText('SHIPPED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('✓')).toHaveLength(2);
    expect(screen.getByText('aaaaaaaaaaaa…')).toBeTruthy();
    expect(screen.getByText(/Chain verified/)).toBeTruthy();
  });

  it('marks a broken chain with ✗ and the invalid notice', async () => {
    state.chainValid = false;
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Custody timeline' }));
    await waitFor(() => expect(screen.getByText(/Chain broken/)).toBeTruthy());
    expect(screen.getAllByText('✗')).toHaveLength(2);
  });

  it('records a custody event and refreshes the timeline', async () => {
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Custody timeline' }));
    await waitFor(() => expect(screen.getAllByText('CREATED').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'bagged' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record event' }));
    await waitFor(() => expect(screen.getByText(/bagged/)).toBeTruthy());
    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/lots/lot-1/events') && (init as RequestInit)?.method === 'POST'
    );
    expect(post).toBeTruthy();
  });

  it('creates a lot through the form', async () => {
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Crop'), { target: { value: 'Sesame' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Harvest start'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Harvest end'), { target: { value: '2026-03-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create lot' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/traceability/lots') && (init as RequestInit)?.method === 'POST'
      );
      expect(post).toBeTruthy();
    });
  });

  it('builds a shipment from picked lots and exports the DDS with an honest basis', async () => {
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Cocoa — 500 kg/));
    fireEvent.click(screen.getByRole('button', { name: 'Create shipment' }));
    await waitFor(() => expect(screen.getByTestId('shipment-panel')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download DDS JSON' }));
    await waitFor(() => expect(screen.getByTestId('dds-status')).toBeTruthy());
    expect(screen.getByTestId('dds-status').textContent).toContain('stub');
    expect(screen.getByTestId('dds-status').textContent).toContain('exporter');
    expect(state.shipmentCreated).toBe(true);
  });

  it('verifies a shipment chain from the verify panel', async () => {
    renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Cocoa — 500 kg/));
    fireEvent.click(screen.getByRole('button', { name: 'Create shipment' }));
    await waitFor(() => expect(screen.getByTestId('shipment-panel')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Verify shipment' }));
    await waitFor(() => expect(screen.getByTestId('verify-status')).toBeTruthy());
    expect(screen.getByTestId('verify-status').textContent).toContain('2 events');
  });

  it('has no obvious accessibility violations', async () => {
    const { container } = renderWithProviders(<TraceabilityHub />);
    await waitFor(() => expect(screen.getByText('Cocoa')).toBeTruthy());
    const results = await axe(container, AXE_OPTIONS);
    expect(results).toHaveNoViolations();
  });
});

describe('HashBadge', () => {
  afterEach(() => cleanup());

  it('truncates the hash and keeps the full value in the tooltip', () => {
    render(<HashBadge hash={'f'.repeat(64)} label="Event hash" />);
    const badge = screen.getByLabelText('Event hash: ffffffffffff…');
    expect(badge.textContent).toBe('ffffffffffff…');
    expect(badge.getAttribute('title')).toBe('f'.repeat(64));
  });
});
