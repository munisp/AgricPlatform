import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { clearApiCache } from '@/lib/api/hooks';
import { CheckRow, Field, TextInput } from '@/components/forms';
import { EmptyState, ProgressBar, StatusBadge } from '@/components/ui';
import { OpportunityBrowser } from '@/components/opportunity-browser';
import { OnboardingWizard } from '@/components/onboarding-wizard';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded, so axe's
// color-contrast rule cannot compute real ratios — that is covered by
// test/contrast.test.ts against the CSS source instead.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const OPPORTUNITY = {
  id: 'opp-axe-grant',
  title: 'Axe Test Grant',
  type: 'grant',
  description: 'A grant for axe testing.',
  states: ['Kano'],
  valueChains: ['Vegetables'],
  eligibility: ['Verified profile'],
  deadline: '2026-12-01T00:00:00.000Z',
  isActive: true
};

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

describe('axe smoke tests (headless, jsdom)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/api/v1/opportunities')) {
        return jsonResponse({ data: [OPPORTUNITY], total: 1, page: 1, pageSize: 100 });
      }
      return jsonResponse({ data: [] });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('form and ui primitives have no violations', async () => {
    const { container } = render(
      <form aria-label="axe primitives">
        <Field id="t1" label="Phone" hint="Used for OTP sign-in">
          <TextInput id="t1" inputMode="tel" />
        </Field>
        <CheckRow id="c1" checked onChange={() => {}} label="SMS alerts" />
        <ProgressBar value={40} label="Profile completion" />
        <StatusBadge tone="info">grant</StatusBadge>
        <EmptyState title="Nothing here" />
      </form>
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('Field wires aria-describedby to the hint', () => {
    const { container } = render(
      <Field id="t2" label="Phone" hint="Used for OTP sign-in">
        <TextInput id="t2" />
      </Field>
    );
    expect(container.querySelector('input')?.getAttribute('aria-describedby')).toBe('t2-hint');
    expect(container.querySelector('#t2-hint')?.textContent).toBe('Used for OTP sign-in');
  });

  it('OpportunityBrowser composite has no violations', async () => {
    const { container } = render(
      <AppProvider>
        <OpportunityBrowser />
      </AppProvider>
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Axe Test Grant');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('OpportunityBrowser exposes a labelled filter group and live result count', async () => {
    const { container } = render(
      <AppProvider>
        <OpportunityBrowser />
      </AppProvider>
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Axe Test Grant');
    });
    const fieldset = container.querySelector('fieldset');
    expect(fieldset?.querySelector('legend')?.textContent).toBe('Filter opportunities');
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(
      container.querySelector('[aria-label="Apply for Axe Test Grant"]')
    ).toBeTruthy();
  });

  it('OnboardingWizard composite has no violations', async () => {
    const { container } = render(
      <AppProvider>
        <OnboardingWizard />
      </AppProvider>
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Full name');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
