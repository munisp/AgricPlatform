import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { MyWebinarRegistrations } from '@/components/knowledge-live';
import { ChannelStatusCards, mapChannels } from '@/components/channel-status';
import type { IntegrationStatus } from '@agric-platform/shared';

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

const WEBINAR_UPCOMING = {
  id: 'web-1',
  title: 'Dry season planning Q&A',
  hostUserId: 'user-host',
  startsAt: '2099-05-01T10:00:00.000Z',
  timezone: 'Africa/Lagos',
  status: 'scheduled',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const WEBINAR_PAST = {
  id: 'web-2',
  title: 'Wet season recap',
  hostUserId: 'user-host',
  startsAt: '2020-05-01T10:00:00.000Z',
  timezone: 'Africa/Lagos',
  recordingUrl: 'https://cdn.example.com/recaps/wet-season.mp4',
  status: 'completed',
  createdAt: '2020-01-01T00:00:00.000Z'
};

const REGISTRATIONS = [
  { id: 'reg-1', webinarId: 'web-1', userId: 'user-adamu', registeredAt: '2026-02-20T00:00:00.000Z' },
  { id: 'reg-2', webinarId: 'web-2', userId: 'user-adamu', registeredAt: '2020-04-20T00:00:00.000Z' }
];

function integration(provider: string, driver: string, configured: boolean): IntegrationStatus {
  return {
    provider,
    capability: `${provider} capability`,
    driver: driver as IntegrationStatus['driver'],
    configured,
    healthy: configured
  };
}

describe('My webinar registrations', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/v1/webinars/mine/registrations')) {
        return jsonResponse({ data: REGISTRATIONS });
      }
      if (path.endsWith('/api/v1/webinars')) {
        return jsonResponse({ data: [WEBINAR_UPCOMING, WEBINAR_PAST] });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('lists registrations joined with webinar titles', async () => {
    renderWithProviders(<MyWebinarRegistrations />);
    await waitFor(() => {
      expect(screen.getByText('Dry season planning Q&A')).toBeTruthy();
    });
    expect(screen.getByText('Wet season recap')).toBeTruthy();
  });

  it('shows a recording link for past webinars and a join note for upcoming ones', async () => {
    renderWithProviders(<MyWebinarRegistrations />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Watch recording' })).toBeTruthy();
    });
    expect(
      screen.getByRole('link', { name: 'Watch recording' }).getAttribute('href')
    ).toBe('https://cdn.example.com/recaps/wet-season.mp4');
    expect(screen.getByText(/Join details are shared before the session/)).toBeTruthy();
  });

  it('shows an empty state when there are no registrations', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/v1/webinars/mine/registrations')) {
        return jsonResponse({ data: [] });
      }
      if (path.endsWith('/api/v1/webinars')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ data: null });
    });
    renderWithProviders(<MyWebinarRegistrations />);
    await waitFor(() => {
      expect(screen.getByText('No registrations yet')).toBeTruthy();
    });
  });
});

describe('Channel status cards', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('maps providers onto channels and marks USSD/IVR as not wired', () => {
    const statuses = mapChannels([
      integration('termii', 'sandbox', true),
      integration('whatsapp', 'stub', false),
      integration('mailgun', 'stub', true),
      integration('onesignal', 'production', true)
    ]);
    expect(statuses).toHaveLength(6);
    expect(statuses.find((s) => s.channel === 'SMS')?.integration?.driver).toBe('sandbox');
    expect(statuses.find((s) => s.channel === 'Push')?.integration?.driver).toBe('production');
    expect(statuses.find((s) => s.channel === 'USSD')?.integration).toBeNull();
    expect(statuses.find((s) => s.channel === 'IVR')?.integration).toBeNull();
  });

  it('renders driver and configured badges per channel', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/v1/integrations')) {
        return jsonResponse({
          data: [
            integration('termii', 'sandbox', true),
            integration('whatsapp', 'stub', false),
            integration('mailgun', 'stub', true),
            integration('onesignal', 'stub', false)
          ]
        });
      }
      return jsonResponse({ data: null });
    });
    renderWithProviders(<ChannelStatusCards />);
    await waitFor(() => {
      expect(screen.getByText('SMS')).toBeTruthy();
    });
    for (const channel of ['WhatsApp', 'USSD', 'IVR', 'Email', 'Push']) {
      expect(screen.getByText(channel)).toBeTruthy();
    }
    expect(screen.getAllByText('not wired')).toHaveLength(2);
    expect(screen.getByText('sandbox')).toBeTruthy();
    expect(screen.getAllByText('awaiting credentials').length).toBeGreaterThan(0);
    expect(screen.getAllByText('configured').length).toBeGreaterThan(0);
  });
});
