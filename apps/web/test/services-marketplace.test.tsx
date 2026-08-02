import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { SupplierDirectory, SupplierDetail, MyBookings } from '@/components/services-live';

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

const SUPPLIER = {
  id: 'supplier-1',
  ownerUserId: 'user-supplier',
  businessName: 'Kano Tractor Hire',
  categories: ['machinery_hire'],
  statesCovered: ['Kano'],
  lgasCovered: ['Kano Municipal'],
  verificationStatus: 'verified',
  averageRating: 4.5,
  ratingCount: 12,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const OFFERING = {
  id: 'offering-1',
  supplierId: 'supplier-1',
  category: 'machinery_hire',
  title: 'Tractor hire — day rate',
  description: '75hp tractor with operator.',
  priceNaira: 45000,
  pricingUnit: 'per_day',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const BOOKING = {
  id: 'booking-1',
  offeringId: 'offering-1',
  supplierId: 'supplier-1',
  customerId: 'user-adamu',
  quantity: 1,
  totalNaira: 45000,
  scheduledStart: '2026-03-01T00:00:00.000Z',
  scheduledEnd: '2026-03-02T00:00:00.000Z',
  status: 'quoted',
  createdAt: '2026-02-01T00:00:00.000Z'
};

const REVIEW = {
  id: 'review-1',
  bookingId: 'booking-1',
  supplierId: 'supplier-1',
  authorId: 'user-adamu',
  rating: 5,
  comment: 'Reliable operator.',
  createdAt: '2026-02-10T00:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith('/api/v1/service-suppliers') && (!init?.method || init.method === 'GET')) {
    return jsonResponse({ data: [SUPPLIER], total: 1, page: 1, pageSize: 60 });
  }
  if (path.endsWith(`/api/v1/service-suppliers/${SUPPLIER.id}/offerings`)) {
    return jsonResponse({ data: [OFFERING] });
  }
  if (path.endsWith(`/api/v1/service-suppliers/${SUPPLIER.id}/reviews`)) {
    return jsonResponse({ data: [REVIEW] });
  }
  if (path.endsWith(`/api/v1/service-suppliers/${SUPPLIER.id}`)) {
    return jsonResponse({ data: SUPPLIER });
  }
  if (path.endsWith(`/api/v1/service-offerings/${OFFERING.id}/bookings`) && init?.method === 'POST') {
    return jsonResponse({ data: BOOKING });
  }
  if (path.endsWith(`/api/v1/service-bookings/${BOOKING.id}/status`) && init?.method === 'POST') {
    return jsonResponse({ data: { ...BOOKING, status: 'accepted' } });
  }
  if (path.endsWith(`/api/v1/service-bookings/${BOOKING.id}`)) {
    return jsonResponse({ data: BOOKING });
  }
  return jsonResponse({ data: null });
}

describe('Services marketplace', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the supplier directory with verification and rating', async () => {
    renderWithProviders(<SupplierDirectory />);
    await waitFor(() => {
      expect(screen.getByText('Kano Tractor Hire')).toBeTruthy();
    });
    expect(screen.getByText('verified')).toBeTruthy();
    expect(screen.getByText('4.5 (12)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View supplier' })).toBeTruthy();
  });

  it('applies the category filter to the directory request', async () => {
    renderWithProviders(<SupplierDirectory />);
    await waitFor(() => {
      expect(screen.getByText('Kano Tractor Hire')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cold_storage' } });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('category=cold_storage')
      );
      expect(call).toBeTruthy();
    });
  });

  it('renders supplier detail with offerings and reviews', async () => {
    renderWithProviders(<SupplierDetail supplierId={SUPPLIER.id} />);
    await waitFor(() => {
      expect(screen.getByText('Tractor hire — day rate')).toBeTruthy();
    });
    expect(screen.getByText('Reliable operator.')).toBeTruthy();
    expect(screen.getByLabelText('Average rating 4.5 from 12 reviews')).toBeTruthy();
  });

  it('runs the booking request flow and records the booking locally', async () => {
    renderWithProviders(<SupplierDetail supplierId={SUPPLIER.id} />);
    await waitFor(() => {
      expect(screen.getByText('Tractor hire — day rate')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Request booking for Tractor hire — day rate from Kano Tractor Hire' })
    );
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-03-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes(`/service-offerings/${OFFERING.id}/bookings`) &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.customerId).toBe('user-adamu');
      expect(body.scheduledStart).toContain('2026-03-01');
    });

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('agric.my-service-bookings') ?? '[]');
      expect(stored).toContain('booking-1');
    });
  });

  it('shows the booking status timeline with accept-quote action for quoted bookings', async () => {
    window.localStorage.setItem('agric.my-service-bookings', JSON.stringify(['booking-1']));
    renderWithProviders(<MyBookings />);

    await waitFor(() => {
      expect(screen.getByText('Booking #1')).toBeTruthy();
    });
    // Timeline includes the pipeline stages up to "quoted" (status badge +
    // timeline step both render the word).
    expect(screen.getByText('requested')).toBeTruthy();
    expect(screen.getAllByText('quoted').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole('button', { name: 'Accept quote' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes(`/service-bookings/${BOOKING.id}/status`) &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).status).toBe('accepted');
    });
  });
});
