import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { RecommendationsRail, humaniseReason } from '@/components/recommendations-rail';

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

const RECO = {
  type: 'course',
  id: 'course-maize',
  title: 'Maize agronomy basics',
  summary: 'Spacing, fertiliser and pest control for maize.',
  score: 6.4,
  reasons: ['same_crop', 'state_match']
};

const RECO_2 = {
  type: 'opportunity',
  id: 'opp-grant',
  title: 'Dry season grant',
  summary: 'A matching grant for irrigation kits.',
  score: 4.1,
  reasons: ['trending_fallback']
};

describe('Recommendations rail', () => {
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

  it('renders nothing when the API returns an empty rail', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ data: [] }));
    const { container } = renderWithProviders(<RecommendationsRail />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Recommended for you')).toBeNull();
  });

  it('renders cards with type badge and humanised reason chips', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ data: [RECO, RECO_2] }));
    renderWithProviders(<RecommendationsRail />);
    await waitFor(() => {
      expect(screen.getByText('Maize agronomy basics')).toBeTruthy();
    });
    expect(screen.getByText('Course')).toBeTruthy();
    expect(screen.getByText('Matches your crops')).toBeTruthy();
    expect(screen.getByText('In your state')).toBeTruthy();
    expect(screen.getByText('Trending now')).toBeTruthy();
  });

  it('posts clicked feedback and shows the saved state', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith(`/api/v1/recommendations/${RECO.id}/feedback`) && init?.method === 'POST') {
        return jsonResponse({ data: { recorded: true } });
      }
      return jsonResponse({ data: [RECO] });
    });
    renderWithProviders(<RecommendationsRail />);
    await waitFor(() => {
      expect(screen.getByText('Maize agronomy basics')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await waitFor(() => {
      expect(screen.getByText('saved')).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes(`/recommendations/${RECO.id}/feedback`) &&
      (init as RequestInit)?.method === 'POST'
    );
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      type: 'course',
      action: 'clicked'
    });
  });

  it('dismisses a card optimistically on "Not interested"', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes('/feedback') && init?.method === 'POST') {
        return jsonResponse({ data: { recorded: true } });
      }
      return jsonResponse({ data: [RECO, RECO_2] });
    });
    renderWithProviders(<RecommendationsRail />);
    await waitFor(() => {
      expect(screen.getByText('Maize agronomy basics')).toBeTruthy();
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Not interested' })[0]);
    await waitFor(() => {
      expect(screen.queryByText('Maize agronomy basics')).toBeNull();
    });
    expect(screen.getByText('Dry season grant')).toBeTruthy();
  });

  it('restores the card and shows failed state when dismiss fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes('/feedback') && init?.method === 'POST') {
        return jsonResponse(
          { statusCode: 500, error: 'Server Error', message: 'boom', path, timestamp: '' },
          500
        );
      }
      return jsonResponse({ data: [RECO] });
    });
    renderWithProviders(<RecommendationsRail />);
    await waitFor(() => {
      expect(screen.getByText('Maize agronomy basics')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Not interested' }));
    await waitFor(() => {
      expect(screen.getByText('Feedback not saved — try again.')).toBeTruthy();
    });
    // Card is restored after the failed optimistic dismiss.
    expect(screen.getByText('Maize agronomy basics')).toBeTruthy();
  });

  it('humanises every known reason code', () => {
    expect(humaniseReason('same_crop')).toBe('Matches your crops');
    expect(humaniseReason('lga_match')).toBe('Near you');
    expect(humaniseReason('value_chain_match')).toBe('Matches your value chain');
    expect(humaniseReason('category_affinity')).toBe('Similar to your courses');
    expect(humaniseReason('purchased_category')).toBe('Based on your orders');
    expect(humaniseReason('completed_prerequisite')).toBe('You finished the prerequisite');
    expect(humaniseReason('trending_fallback')).toBe('Trending now');
  });
});
