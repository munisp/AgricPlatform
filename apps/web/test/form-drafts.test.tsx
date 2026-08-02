import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { getDraftsDb } from '@/lib/drafts';
import { ListingForm } from '@/components/listing-form';

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

const CREATED_LISTING = {
  id: 'listing-new-1',
  sellerId: 'user-adamu',
  kind: 'produce',
  title: 'Fresh cassava tubers',
  quantity: 5,
  unit: 'tonne',
  priceNaira: 185000,
  location: { state: 'Kaduna', lga: 'Zaria' },
  isActive: true
};

describe('IndexedDB form drafts (listing creation)', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() => jsonResponse({ data: CREATED_LISTING }));
    const db = getDraftsDb();
    if (db) await db.drafts.clear();
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('autosaves on keystroke and restores the draft after a reload (remount)', async () => {
    const first = renderWithProviders(<ListingForm />);
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Fresh cassava tubers' }
    });
    fireEvent.change(screen.getByLabelText('Total price (₦)'), { target: { value: '185000' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kaduna' } });

    // Debounced autosave (300ms) lands in IndexedDB.
    await waitFor(
      async () => {
        const record = await getDraftsDb()?.drafts.get('listing-create');
        expect(record?.data).toMatchObject({ title: 'Fresh cassava tubers', priceNaira: '185000' });
      },
      { timeout: 3000 }
    );
    first.unmount();

    renderWithProviders(<ListingForm />);
    await waitFor(() => {
      expect(screen.getByTestId('draft-restored')).toBeTruthy();
    });
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Fresh cassava tubers');
    expect((screen.getByLabelText('Total price (₦)') as HTMLInputElement).value).toBe('185000');
  });

  it('clears the stored draft after a successful submit', async () => {
    renderWithProviders(<ListingForm />);
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Fresh cassava tubers' }
    });
    fireEvent.change(screen.getByLabelText('Total price (₦)'), { target: { value: '185000' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kaduna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));

    await waitFor(() => {
      expect(screen.getByText(/Listing published/i)).toBeTruthy();
    });
    await waitFor(async () => {
      const record = await getDraftsDb()?.drafts.get('listing-create');
      expect(record).toBeUndefined();
    });
    // The form is reset for the next listing.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  });

  it('keeps the draft when the submit fails (nothing typed is lost)', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      jsonResponse(
        {
          statusCode: 500,
          error: 'Internal Server Error',
          message: 'boom',
          path: '/listings',
          timestamp: new Date().toISOString()
        },
        500
      )
    );

    renderWithProviders(<ListingForm />);
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Fresh cassava tubers' }
    });
    fireEvent.change(screen.getByLabelText('Total price (₦)'), { target: { value: '185000' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kaduna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    });
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Fresh cassava tubers');
  });
});

describe('IndexedDB form drafts (registration)', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() => jsonResponse({ data: null }));
    const db = getDraftsDb();
    if (db) await db.drafts.clear();
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('autosaves the onboarding draft and restores it after a remount', async () => {
    const { OnboardingWizard } = await import('@/components/onboarding-wizard');

    const first = renderWithProviders(<OnboardingWizard />);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Amina Yusuf' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '08030000000' } });

    await waitFor(
      async () => {
        const record = await getDraftsDb()?.drafts.get('registration');
        expect(record?.data).toMatchObject({ fullName: 'Amina Yusuf', phone: '08030000000' });
      },
      { timeout: 3000 }
    );
    first.unmount();

    renderWithProviders(<OnboardingWizard />);
    await waitFor(() => {
      expect(screen.getByTestId('draft-restored')).toBeTruthy();
    });
    expect((screen.getByLabelText('Full name') as HTMLInputElement).value).toBe('Amina Yusuf');
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('08030000000');
  });

  it('discards the restored draft via the notice action', async () => {
    const { OnboardingWizard } = await import('@/components/onboarding-wizard');

    const db = getDraftsDb();
    await db?.drafts.put({
      id: 'registration',
      data: {
        fullName: 'Amina Yusuf',
        phone: '08030000000',
        role: 'farmer',
        language: 'en',
        state: '',
        lga: '',
        farmingInterests: [],
        valueChains: [],
        bio: '',
        farmSizeHectares: '',
        yearsExperience: ''
      },
      updatedAt: Date.now()
    });

    renderWithProviders(<OnboardingWizard />);
    await waitFor(() => {
      expect(screen.getByTestId('draft-restored')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(async () => {
      const record = await getDraftsDb()?.drafts.get('registration');
      expect(record).toBeUndefined();
    });
    expect((screen.getByLabelText('Full name') as HTMLInputElement).value).toBe('');
  });
});

describe('IndexedDB form drafts (course enrolment goal)', () => {
  const fetchMock = vi.fn();

  const COURSE = {
    id: 'course-irrigation',
    title: 'Dry-Season Irrigation',
    category: 'Water',
    level: 'beginner',
    durationMinutes: 45,
    enrolmentCount: 120,
    offlineAvailable: true
  };

  beforeEach(async () => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/api/v1/courses')) {
        return jsonResponse({ data: [COURSE], total: 1, page: 1, pageSize: 100 });
      }
      if (parsed.pathname.includes('/enrolments')) {
        return jsonResponse({ data: [] });
      }
      if (parsed.pathname.includes('/enrol')) {
        return jsonResponse({
          data: {
            id: 'enrol-1',
            courseId: COURSE.id,
            userId: 'user-adamu',
            status: 'active',
            progressPercent: 0
          }
        });
      }
      return jsonResponse({ data: null });
    });
    const db = getDraftsDb();
    if (db) await db.drafts.clear();
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('persists the enrolment goal note across a remount and clears it on enrol', async () => {
    const { CourseCatalogue } = await import('@/components/learning-live');

    const first = renderWithProviders(<CourseCatalogue />);
    await waitFor(() => {
      expect(screen.getByText('Dry-Season Irrigation')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol in Dry-Season Irrigation' }));
    fireEvent.change(screen.getByLabelText('Your goal for this course (optional)'), {
      target: { value: 'Water my tomatoes all season' }
    });

    await waitFor(
      async () => {
        const record = await getDraftsDb()?.drafts.get(`course-enrol-${COURSE.id}`);
        expect(record?.data).toMatchObject({ goal: 'Water my tomatoes all season' });
      },
      { timeout: 3000 }
    );
    first.unmount();

    renderWithProviders(<CourseCatalogue />);
    await waitFor(() => {
      expect(screen.getByText('Dry-Season Irrigation')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol in Dry-Season Irrigation' }));
    expect(screen.getByTestId('draft-restored')).toBeTruthy();
    expect(
      (screen.getByLabelText('Your goal for this course (optional)') as HTMLInputElement).value
    ).toBe('Water my tomatoes all season');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm enrolment' }));
    await waitFor(async () => {
      const record = await getDraftsDb()?.drafts.get(`course-enrol-${COURSE.id}`);
      expect(record).toBeUndefined();
    });
  });
});
