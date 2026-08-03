import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  EquipmentBookingDetail,
  EquipmentBrowser,
  EquipmentListingDetail,
  MyEquipmentBookings,
  OwnerDashboard
} from '@/components/mechanization-live';
import type { EquipmentBooking, EquipmentListing } from '@/lib/api/endpoints';

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

const LISTING: EquipmentListing = {
  id: 'mechlisting-1',
  ownerUserId: 'user-owner',
  ownerType: 'cooperative',
  type: 'tractor',
  title: '75hp tractor with plough',
  description: 'Well maintained',
  specs: { horsepower: 75 },
  baseLat: 12.0022,
  baseLong: 8.592,
  serviceAreaH3: ['8539507fffffff', '8539503fffffff'],
  serviceAreaResolution: 5,
  rates: { perHaNaira: 25000, perKmNaira: 500, includedKm: 20 },
  availability: [{ start: '2026-01-01T00:00:00.000Z', end: '2027-12-31T00:00:00.000Z' }],
  operatorLicenseRef: 'doc-license-1',
  operatorVerification: 'verified',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const BOOKING: EquipmentBooking = {
  id: 'mechbooking-1',
  listingId: LISTING.id,
  ownerUserId: 'user-owner',
  farmerId: 'user-farmer',
  plotLat: 12.05,
  plotLong: 8.62,
  plotH3: '8539507fffffff',
  areaHa: 2,
  windowStart: '2026-09-10T08:00:00.000Z',
  windowEnd: '2026-09-10T12:00:00.000Z',
  status: 'quoted',
  quote: {
    areaComponentKobo: 5_000_000,
    hourComponentKobo: 0,
    distanceSurchargeKobo: 0,
    distanceKm: 6.13,
    seasonalMultiplier: 1.05,
    seasonalMonth: 9,
    subtotalKobo: 5_000_000,
    totalKobo: 5_250_000,
    quotedAt: '2026-09-01T00:00:00.000Z'
  },
  advisory: { severe: true, basis: 'http:flood-ml sidecar v1', severity: 'severe', h3Cell: '8539507fffffff' },
  holdEntryId: 'entry-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
};

const STATS = {
  ownerUserId: 'user-owner',
  listingCount: 1,
  bookedHours: 4,
  completedBookings: 1,
  cancelledBookings: 1,
  disputedBookings: 0,
  completionRate: 0.5,
  revenueClearedKobo: 5_250_000
};

function mockApi(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/mechanization/listings') && method === 'GET') {
      return jsonResponse({ data: [LISTING] });
    }
    if (path.endsWith(`/mechanization/listings/${LISTING.id}`)) {
      return jsonResponse({ data: LISTING });
    }
    if (path.endsWith('/mechanization/listings/mine')) {
      return jsonResponse({ data: [LISTING] });
    }
    if (path.endsWith('/mechanization/bookings/mine')) {
      return jsonResponse({ data: [BOOKING] });
    }
    if (path.endsWith('/mechanization/bookings/queue')) {
      return jsonResponse({ data: [{ ...BOOKING, status: 'requested' }] });
    }
    if (path.endsWith('/mechanization/owner/stats')) {
      return jsonResponse({ data: STATS });
    }
    if (path.endsWith(`/mechanization/bookings/${BOOKING.id}`)) {
      return jsonResponse({ data: BOOKING });
    }
    if (path.endsWith(`/mechanization/listings/${LISTING.id}/bookings`) && method === 'POST') {
      return jsonResponse({ data: { ...BOOKING, status: 'requested' } });
    }
    if (path.endsWith(`/mechanization/bookings/${BOOKING.id}/quote`) && method === 'POST') {
      return jsonResponse({ data: BOOKING });
    }
    return jsonResponse({ message: 'not found' }, 404);
  });
}

describe('Mechanization marketplace (wave-mechanization)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mockApi(fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('browse renders listing cards with rates and the operator badge', async () => {
    renderWithProviders(<EquipmentBrowser />);
    await waitFor(() => expect(screen.getByText('75hp tractor with plough')).toBeTruthy());
    expect(screen.getByText(/25,000/)).toBeTruthy();
    expect(screen.getByText('verified')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Listing detail/i }).getAttribute('href')).toBe(
      `/mechanization/listings/${LISTING.id}`
    );
  });

  it('type filter refetches with the selected type', async () => {
    renderWithProviders(<EquipmentBrowser />);
    await waitFor(() => expect(screen.getByText('75hp tractor with plough')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Equipment type'), { target: { value: 'harvester' } });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('type=harvester'))
      ).toBe(true)
    );
  });

  it('shows the empty state when nothing matches', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ data: [] }));
    renderWithProviders(<EquipmentBrowser />);
    await waitFor(() =>
      expect(screen.getByText('No equipment matches these filters yet.')).toBeTruthy()
    );
  });

  it('listing detail shows rates, service area summary and verified operator badge', async () => {
    renderWithProviders(<EquipmentListingDetail listingId={LISTING.id} />);
    await waitFor(() => expect(screen.getByText('Operator verified')).toBeTruthy());
    expect(screen.getByText(/2 H3 cells at resolution 5/)).toBeTruthy();
    expect(screen.getByText(/per km beyond 20 km included/)).toBeTruthy();
    expect(screen.getByText('horsepower: 75')).toBeTruthy();
  });

  it('booking form stays disabled until valid and posts the request', async () => {
    renderWithProviders(<EquipmentListingDetail listingId={LISTING.id} />);
    await waitFor(() => expect(screen.getByText('Operator verified')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Request booking' }));
    const submit = screen.getAllByRole('button', { name: 'Request booking' })[0];
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Plot latitude'), { target: { value: '12.05' } });
    fireEvent.change(screen.getByLabelText('Plot longitude'), { target: { value: '8.62' } });
    fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '2026-09-10T08:00' } });
    fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '2026-09-10T12:00' } });
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes(`/mechanization/listings/${LISTING.id}/bookings`) &&
            (init?.method ?? 'GET') === 'POST'
        )
      ).toBe(true)
    );
  });

  it('my bookings lists bookings with status badges and detail links', async () => {
    renderWithProviders(<MyEquipmentBookings />);
    await waitFor(() => expect(screen.getByText('quoted')).toBeTruthy());
    expect(screen.getByText(/2 ha/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Booking detail/i }).getAttribute('href')).toBe(
      `/mechanization/bookings/${BOOKING.id}`
    );
  });

  it('booking detail shows the timeline, quote total and severe advisory with basis', async () => {
    renderWithProviders(<EquipmentBookingDetail bookingId={BOOKING.id} />);
    await waitFor(() => expect(screen.getByText(/Flood advisory: severe/)).toBeTruthy());
    expect(screen.getByText(/Basis: http:flood-ml sidecar v1/)).toBeTruthy();
    expect(screen.getByText('×1.05')).toBeTruthy();
    // Timeline reaches at least the quoted step.
    expect(screen.getByText('quoted')).toBeTruthy();
    // ₦52,500 total formatted from kobo.
    expect(screen.getAllByText(/52,500/).length).toBeGreaterThan(0);
  });

  it('owner dashboard shows utilization and lets the owner quote a request', async () => {
    renderWithProviders(<OwnerDashboard />);
    await waitFor(() => expect(screen.getByText('50%')).toBeTruthy());
    expect(screen.getByText('4')).toBeTruthy(); // booked hours
    fireEvent.click(screen.getByRole('button', { name: 'Send quote' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes(`/mechanization/bookings/${BOOKING.id}/quote`) &&
            (init?.method ?? 'GET') === 'POST'
        )
      ).toBe(true)
    );
  });

  it('browse has no accessibility violations', async () => {
    const { container } = renderWithProviders(<EquipmentBrowser />);
    await waitFor(() => expect(screen.getByText('75hp tractor with plough')).toBeTruthy());
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
