import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DOM-render tests for the framework-free widget bundles in
 * apps/web/public/widgets (wave P5d). Each bundle is executed against a
 * jsdom page containing the documented embed snippet, with fetch mocked.
 */

const WIDGETS_DIR = join(__dirname, '..', 'public', 'widgets');
const API = 'https://api.test/api/v1';

function loadWidget(name: string, targetId: string) {
  document.body.innerHTML = `
    <div id="${targetId}"></div>
    <script src="https://app.agricplatform.ng/widgets/${name}.js"
            data-target="#${targetId}"
            data-api="${API}"></script>`;
  const source = readFileSync(join(WIDGETS_DIR, `${name}.js`), 'utf8');
  (0, eval)(source);
}

function mockFetchJson(body: unknown, ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body
  })) as unknown as typeof fetch;
}

describe('widget bundles', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opportunities.js renders the directory feed', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({
        data: [
          { id: 'o1', title: 'BOI Youth Grant', type: 'grant', states: ['Kano'], deadline: '2026-09-30' }
        ]
      })
    );
    loadWidget('opportunities', 'opps');
    await vi.waitFor(() => {
      expect(document.querySelector('#opps li strong')?.textContent).toBe('BOI Youth Grant');
    });
    expect(document.querySelector('#opps')?.textContent).toContain('Kano');
    expect(document.querySelector('#opps')?.textContent).toContain('2026-09-30');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/embed/opportunities?limit=10`);
  });

  it('opportunities.js shows an empty state', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ data: [] }));
    loadWidget('opportunities', 'opps-empty');
    await vi.waitFor(() => {
      expect(document.querySelector('#opps-empty')?.textContent).toContain(
        'No open opportunities'
      );
    });
  });

  it('prices.js renders NGN-formatted price chips', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({
        data: [
          { commodity: 'Maize', market: 'Dawanau', state: 'Kano', priceNgn: 42000, observedAt: 'x' }
        ]
      })
    );
    loadWidget('prices', 'prices');
    await vi.waitFor(() => {
      expect(document.querySelector('.agric-price-chip')?.textContent).toContain('Maize');
    });
    expect(document.querySelector('.agric-price-chip')?.textContent).toContain('₦42,000');
  });

  it('courses.js renders the catalogue with level and duration', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({
        data: [
          {
            id: 'c1',
            title: 'Intro to Agronomy',
            category: 'agronomy',
            level: 'beginner',
            durationMinutes: 45,
            language: 'en'
          }
        ]
      })
    );
    loadWidget('courses', 'courses');
    await vi.waitFor(() => {
      expect(document.querySelector('#courses li strong')?.textContent).toBe('Intro to Agronomy');
    });
    expect(document.querySelector('#courses')?.textContent).toContain('45 min');
  });

  it('member-button.js renders the CTA from the feed', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({
        data: { label: 'Register as NYFN Member', href: '/onboarding', description: 'Join NYFN' }
      })
    );
    loadWidget('member-button', 'join');
    await vi.waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>('#join a');
      expect(link?.textContent).toBe('Register as NYFN Member');
    });
    const link = document.querySelector<HTMLAnchorElement>('#join a');
    expect(link?.href).toBe('https://app.agricplatform.ng/onboarding');
  });

  it('member-button.js falls back to a static button when the feed fails', async () => {
    vi.stubGlobal('fetch', mockFetchJson({}, false));
    loadWidget('member-button', 'join-fallback');
    await vi.waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>('#join-fallback a');
      expect(link?.textContent).toBe('Register as NYFN Member');
    });
  });

  it('widgets show a graceful error when the feed fails', async () => {
    vi.stubGlobal('fetch', mockFetchJson({}, false));
    loadWidget('courses', 'courses-fail');
    await vi.waitFor(() => {
      expect(document.querySelector('#courses-fail')?.textContent).toContain(
        'temporarily unavailable'
      );
    });
  });

  it('every bundle is framework-free and under 15KB', () => {
    for (const name of ['opportunities', 'prices', 'courses', 'member-button']) {
      const source = readFileSync(join(WIDGETS_DIR, `${name}.js`), 'utf8');
      expect(source.length).toBeLessThan(15_000);
      expect(source).not.toMatch(/import |require\(/);
    }
  });
});
