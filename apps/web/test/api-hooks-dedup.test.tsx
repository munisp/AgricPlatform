import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { clearApiCache, useApiQuery } from '@/lib/api/hooks';

/**
 * In-flight request dedup: N components mounting the same query key in the
 * same tick share one underlying fetch (previously each fired its own GET —
 * e.g. 3× GET /courses on /learning, 2× GET /chapters on /chapters).
 */
describe('useApiQuery in-flight dedup', () => {
  beforeEach(() => {
    clearApiCache();
  });

  afterEach(() => {
    cleanup();
    clearApiCache();
  });

  function Consumer({ testId, fetcher }: { testId: string; fetcher: () => Promise<string[]> }) {
    const { data, source } = useApiQuery<string[]>('dedup:courses', fetcher);
    return (
      <span data-testid={testId}>{data ? `${source}:${data.join(',')}` : 'loading'}</span>
    );
  }

  it('runs one fetch for two concurrent identical queries', async () => {
    const fetcher = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          setTimeout(() => resolve(['agronomy', 'irrigation']), 20);
        })
    );

    render(
      <>
        <Consumer testId="c1" fetcher={fetcher} />
        <Consumer testId="c2" fetcher={fetcher} />
      </>
    );

    await waitFor(() => {
      expect(screen.getByTestId('c1').textContent).toBe('api:agronomy,irrigation');
      expect(screen.getByTestId('c2').textContent).toBe('api:agronomy,irrigation');
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares the fetch error path without fan-out and without a false fallback flash', async () => {
    const fetcher = vi.fn(
      () =>
        new Promise<string[]>((_, reject) => {
          setTimeout(() => reject(new Error('offline')), 20);
        })
    );

    render(
      <>
        <Consumer testId="c1" fetcher={fetcher} />
        <Consumer testId="c2" fetcher={fetcher} />
      </>
    );

    await waitFor(() => {
      // No fallbackData passed: consumers stay in the loading state with an
      // error rather than showing fixture data.
      expect(screen.getByTestId('c1').textContent).toBe('loading');
      expect(screen.getByTestId('c2').textContent).toBe('loading');
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it('serves a fresh cache entry to a later mount without refetching', async () => {
    const fetcher = vi.fn(() => Promise.resolve(['cached']));

    const first = render(<Consumer testId="c1" fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId('c1').textContent).toBe('api:cached'));
    first.unmount();

    // Mount again within the 30s default staleTime: cache hit, no fetch.
    render(<Consumer testId="c2" fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId('c2').textContent).toBe('cache:cached'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
