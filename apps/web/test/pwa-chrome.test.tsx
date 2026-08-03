import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/dictionaries/en';
import { ha } from '@/lib/i18n/dictionaries/ha';
import { yo } from '@/lib/i18n/dictionaries/yo';
import { ig } from '@/lib/i18n/dictionaries/ig';
import { Nav } from '@/components/nav';
import { QueueList } from '@/components/queue-list';
import { InstallPrompt } from '@/components/install-prompt';
import OfflinePage from '@/app/offline/page';
import NotFound from '@/app/not-found';

/**
 * Wave PWAFIX coverage: nav orphan fixes, dev-only role pill, branded 404,
 * offline page copy, install prompt, distinct queue/sync labels, i18n keys
 * and the Lighthouse CI route/assertion guards.
 */

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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse({ data: [] })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('top navigation', () => {
  it('links to the previously orphaned /farms and /agents routes', () => {
    renderWithProviders(<Nav />);
    // /farms is on the primary row; /agents moved to the "More" overflow
    // menu in the Wave UIUX restructure (still one click from the header).
    expect(screen.getByRole('link', { name: 'Farms' }).getAttribute('href')).toBe('/farms');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Field agents' }).getAttribute('href')).toBe(
      '/agents'
    );
  });

  it('hides the dev role pill in production builds', () => {
    vi.stubEnv('NODE_ENV', 'production');
    renderWithProviders(<Nav />);
    expect(screen.queryByLabelText(/View as role/i)).toBeNull();
  });

  it('shows the dev role pill outside production builds', () => {
    vi.stubEnv('NODE_ENV', 'development');
    renderWithProviders(<Nav />);
    expect(screen.getByLabelText(/View as role/i)).toBeTruthy();
  });
});

describe('offline + not-found pages', () => {
  it('renders the offline page from dictionary copy', () => {
    render(
      <I18nProvider>
        <OfflinePage />
      </I18nProvider>
    );
    expect(screen.getByText('You are offline — no problem.')).toBeTruthy();
    expect(screen.getByText(/Queued submissions stay safe/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Retry connection' }).getAttribute('href')).toBe('/');
    expect(
      screen.getByRole('link', { name: 'Open cached dashboard' }).getAttribute('href')
    ).toBe('/dashboard');
  });

  it('renders a branded, offline-aware 404', () => {
    render(
      <I18nProvider>
        <NotFound />
      </I18nProvider>
    );
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.getByText(/only pages you visited before open/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the homepage' }).getAttribute('href')).toBe('/');
    expect(
      screen.getByRole('link', { name: 'See what works offline' }).getAttribute('href')
    ).toBe('/offline');
  });
});

describe('queue list vs record sync labels', () => {
  it('labels the request-queue flush distinctly from the record-sync action', async () => {
    window.localStorage.setItem(
      'agric.queue',
      JSON.stringify([
        {
          id: 'queue-1',
          kind: 'credit.loan.application',
          label: 'Loan application ₦10,000',
          method: 'POST',
          path: '/credit/applications',
          idempotencyKey: 'idem-1',
          createdAt: '2026-03-01T00:00:00.000Z',
          status: 'queued',
          attempts: 0
        }
      ])
    );
    renderWithProviders(<QueueList />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send queued submissions' })).toBeTruthy()
    );
    // The record-level sync action keeps its own, different label.
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    expect(screen.getByText('Loan application ₦10,000')).toBeTruthy();
  });

  it('renders the empty state from dictionary copy', async () => {
    renderWithProviders(<QueueList />);
    await waitFor(() => expect(screen.getByText('Nothing waiting to sync')).toBeTruthy());
  });
});

describe('install prompt', () => {
  function fireBeforeInstallPrompt() {
    const event = new Event('beforeinstallprompt') as Event & { prompt: ReturnType<typeof vi.fn> };
    event.prompt = vi.fn().mockResolvedValue(undefined);
    fireEvent(window, event);
    return event;
  }

  it('stays hidden until the browser fires beforeinstallprompt', () => {
    render(
      <I18nProvider>
        <InstallPrompt />
      </I18nProvider>
    );
    expect(screen.queryByTestId('install-prompt')).toBeNull();
  });

  it('shows the banner on beforeinstallprompt and calls prompt() on install', async () => {
    render(
      <I18nProvider>
        <InstallPrompt />
      </I18nProvider>
    );
    const event = fireBeforeInstallPrompt();
    await waitFor(() => expect(screen.getByTestId('install-prompt')).toBeTruthy());
    expect(screen.getByText(/Install AgricPlatform/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install app' }));
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('install-prompt')).toBeNull();
  });

  it('dismisses persistently — the banner never nags twice', async () => {
    render(
      <I18nProvider>
        <InstallPrompt />
      </I18nProvider>
    );
    fireBeforeInstallPrompt();
    await waitFor(() => expect(screen.getByTestId('install-prompt')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('install-prompt')).toBeNull();
    expect(window.localStorage.getItem('agric.install.dismissed')).toBe('1');

    // A later visit (new component instance) stays quiet.
    cleanup();
    render(
      <I18nProvider>
        <InstallPrompt />
      </I18nProvider>
    );
    fireBeforeInstallPrompt();
    expect(screen.queryByTestId('install-prompt')).toBeNull();
  });
});

describe('i18n keys for the PWA audit fixes', () => {
  it('defines every new English key used by the fixed components', () => {
    expect(en.nav.farms).toBe('Farms');
    expect(en.nav.agents).toBe('Field agents');
    expect(en.agents.myQueueLink).toBeTruthy();
    expect(en.agents.errorRequired).toBeTruthy();
    expect(en.agents.errorTarget).toBeTruthy();
    expect(en.agents.errorCreate).toBeTruthy();
    expect(en.credit.errorInvalidInput).toBeTruthy();
    expect(en.credit.errorApplyFailed).toBeTruthy();
    expect(en.credit.queuedNotice).toContain('saved on this device');
    expect(en.credit.scoreKicker).toBeTruthy();
    expect(en.credit.applyDescription).toBeTruthy();
    expect(en.credit.queueDescription).toBeTruthy();
    expect(en.credit.groupsDescription).toBeTruthy();
    expect(en.apiState.offlineFallback).toContain('Offline');
    expect(en.apiState.tryAgain).toBeTruthy();
    expect(en.sw.updateAvailable).toBeTruthy();
    expect(en.queue.sendQueued).toBe('Send queued submissions');
    expect(en.queue.sendQueued).not.toBe(en.sync.syncNow);
    expect(en.offline.title).toBeTruthy();
    expect(en.notFound.description).toContain('Offline');
    expect(en.install.action).toBeTruthy();
    expect(en.footer.bottomNote).toContain('sync when you reconnect');
  });

  it('keeps ha/yo/ig as empty scaffolds (no machine translation)', () => {
    expect(Object.keys(ha)).toHaveLength(0);
    expect(Object.keys(yo)).toHaveLength(0);
    expect(Object.keys(ig)).toHaveLength(0);
  });
});

describe('orphaned-route wiring (static guards)', () => {
  // vitest runs with cwd = apps/web.
  const adminHub = readFileSync(resolve(process.cwd(), 'app/admin/page.tsx'), 'utf8');
  const agentsPage = readFileSync(resolve(process.cwd(), 'app/agents/page.tsx'), 'utf8');

  it('admin hub links every existing admin subpage', () => {
    for (const href of [
      '/admin/credit',
      '/admin/analytics',
      '/admin/status',
      '/admin/audit-verify',
      '/admin/feature-flags',
      '/admin/geo',
      '/admin/insights',
      '/admin/integrations'
    ]) {
      expect(adminHub).toContain(`href="${href}"`);
    }
  });

  it('agents page links to /agents/my-queue', () => {
    expect(agentsPage).toContain('href="/agents/my-queue"');
  });
});

describe('lighthouse CI (static guards)', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '../../.github/workflows/lighthouse.yml'),
    'utf8'
  );
  const rc = JSON.parse(
    readFileSync(resolve(process.cwd(), '../../lighthouserc.json'), 'utf8')
  ) as {
    ci: {
      assert: { assertions: Record<string, unknown> };
      upload: { target: string };
    };
  };

  it('audits only routes that exist', () => {
    expect(workflow).not.toContain('${PREVIEW_URL}/login');
    expect(workflow).not.toContain('${PREVIEW_URL}/courses');
    for (const route of ['/', '/onboarding', '/learning', '/marketplace', '/farms', '/credit']) {
      expect(workflow).toContain(`\${PREVIEW_URL}${route}"`);
    }
  });

  it('asserts accessibility >= 0.95 at error level with PWA budgets', () => {
    const assertions = rc.ci.assert.assertions;
    expect(assertions['categories:accessibility']).toEqual(['error', { minScore: 0.95 }]);
    expect(assertions['categories:performance']).toBeDefined();
    expect(assertions['categories:best-practices']).toBeDefined();
    expect(rc.ci.upload.target).toBe('temporary-public-storage');
  });
});

describe('i18n hardcoded-string guards (fixed components)', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('credit-live error copy goes through the dictionary', () => {
    const source = read('components/credit-live.tsx');
    expect(source).not.toContain("'Choose a product and enter a valid amount.'");
    expect(source).not.toContain("'Application failed'");
    expect(source).toContain("t('credit.errorInvalidInput')");
    expect(source).toContain("t('credit.errorApplyFailed')");
  });

  it('agents-board error copy goes through the dictionary', () => {
    const source = read('components/agents-board.tsx');
    expect(source).not.toContain("'Enumerator, state, LGA and purpose are required'");
    expect(source).not.toContain("'Target count must be at least 1'");
    expect(source).toContain("t('agents.errorRequired')");
    expect(source).toContain("t('agents.errorCreate')");
  });

  it('api-state, sw-register, queue-list, offline page and footer use dictionary copy', () => {
    const apiState = read('components/api-state.tsx');
    expect(apiState).not.toContain("'Something went wrong'");
    expect(apiState).not.toContain("'Refreshing…'");
    const swRegister = read('components/sw-register.tsx');
    expect(swRegister).not.toContain('Update available.</span>');
    expect(swRegister).toContain("t('sw.refreshNow')");
    const queueList = read('components/queue-list.tsx');
    expect(queueList).not.toContain("'Sync now'");
    expect(queueList).toContain("t('queue.sendQueued')");
    const offlinePage = read('app/offline/page.tsx');
    expect(offlinePage).not.toContain('You are offline — no problem.</h1>');
    expect(offlinePage).toContain('<T k="offline.title" />');
    const footer = read('components/footer.tsx');
    expect(footer).not.toContain('>Join NYFN</Link>');
    expect(footer).toContain('<T k="footer.tagline" />');
  });
});

describe('route-level error/loading boundaries (static guards)', () => {
  it('ships error.tsx and loading.tsx for /farms and /agents matching /credit', () => {
    for (const route of ['farms', 'agents']) {
      const error = readFileSync(resolve(process.cwd(), `app/${route}/error.tsx`), 'utf8');
      const loading = readFileSync(resolve(process.cwd(), `app/${route}/loading.tsx`), 'utf8');
      expect(error).toContain('RouteError');
      expect(loading).toContain('RouteLoading');
    }
  });

  it('sends HSTS with the security headers', () => {
    const config = readFileSync(resolve(process.cwd(), 'next.config.ts'), 'utf8');
    expect(config).toContain('Strict-Transport-Security');
    expect(config).toContain('includeSubDomains');
  });
});
