import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider, useAppState } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { getDraftsDb } from '@/lib/drafts';
import { OnboardingWizard } from '@/components/onboarding-wizard';
import type { QueuedSubmission } from '@/lib/offline-queue';

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

const REGISTERED_USER = {
  id: 'user-new',
  phone: '08030000000',
  fullName: 'Adamu Garba',
  roles: ['farmer'],
  preferredLanguage: 'en',
  isVerified: false,
  createdAt: '2026-08-01T00:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  const method = init?.method ?? 'GET';
  if (path.endsWith('/api/v1/auth/register') && method === 'POST') {
    return jsonResponse({ data: { user: REGISTERED_USER, otpRequestId: 'otp-1' } });
  }
  if (path.endsWith('/api/v1/profiles/user-new') && method === 'PUT') {
    const body = JSON.parse(String(init?.body));
    return jsonResponse({ data: { userId: 'user-new', ...body } });
  }
  return jsonResponse({ message: 'not found' }, 404);
}

function readStoredQueue(): QueuedSubmission[] {
  return JSON.parse(window.localStorage.getItem('agric.queue') ?? '[]') as QueuedSubmission[];
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

/** Test probe: flushes the offline queue from inside AppProvider. */
function FlushProbe() {
  const { syncQueue } = useAppState();
  return (
    <button type="button" data-testid="flush-queue" onClick={() => void syncQueue()}>
      flush
    </button>
  );
}

function fillRequiredSteps() {
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Adamu Garba' } });
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '08030000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kaduna' } });
  fireEvent.change(screen.getByLabelText('Local government area (LGA)'), {
    target: { value: 'Zaria' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  // Step 2 (interests + value chains) — 'Maize' appears once in each chip
  // group; select it in both.
  for (const chip of screen.getAllByRole('button', { name: 'Maize' })) {
    fireEvent.click(chip);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  // Step 3 (farm details) — all optional.
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  // Step 4: review.
}

describe('OnboardingWizard offline queue', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
    setOnline(true);
    window.localStorage.clear();
    const db = getDraftsDb();
    if (db) await db.drafts.clear();
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('queues registration with a chained profile update and replays both on flush', async () => {
    setOnline(false);
    // The wizard queues on NetworkError/TimeoutError — simulate an
    // unreachable API for the submit, then restore the router for the flush.
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    renderWithProviders(
      <>
        <OnboardingWizard />
        <FlushProbe />
      </>
    );
    fillRequiredSteps();
    fireEvent.click(screen.getByRole('button', { name: 'Finish and join' }));

    // Nothing was sent; one compound queue item holds registration + the
    // wizard profile payload (steps 1–3 data survives offline signup).
    await waitFor(() => {
      const statuses = screen.getAllByRole('status').map((el) => el.textContent ?? '');
      expect(statuses.some((text) => text.includes('saved on this device'))).toBe(true);
    });
    // The only POST attempt is the failed register call that queued.
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toMatch(/\/api\/v1\/auth\/register$/);
    const queued = readStoredQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe('identity.user.registered');
    expect(queued[0]!.path).toBe('/auth/register');
    expect(queued[0]!.chain).toHaveLength(1);
    const step = queued[0]!.chain![0]!;
    expect(step.method).toBe('PUT');
    expect(step.path).toBe('/profiles/{id}');
    expect(step.payload).toMatchObject({
      location: { state: 'Kaduna', lga: 'Zaria' },
      valueChains: ['Maize']
    });

    // Reconnect and flush: register replays first, then the profile PUT runs
    // against the id the register replay returned (user-new via data.user.id).
    setOnline(true);
    fetchMock.mockImplementation(router);
    fireEvent.click(screen.getByTestId('flush-queue'));
    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT'
      );
      expect(puts).toHaveLength(1);
    });
    const sentPosts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(String(sentPosts[0]![0])).toMatch(/\/api\/v1\/auth\/register$/);
    const put = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT'
    )!;
    expect(String(put[0])).toMatch(/\/api\/v1\/profiles\/user-new$/);
    expect(JSON.parse(String(put[1]?.body))).toMatchObject({
      location: { state: 'Kaduna', lga: 'Zaria' },
      valueChains: ['Maize']
    });
    await waitFor(() => {
      expect(readStoredQueue()[0]!.status).toBe('sent');
    });
  });
});
