import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider, T, useT } from '@/lib/i18n';
import { LocaleSwitcher } from '@/components/locale-switcher';

function Probe() {
  const { t, locale } = useT();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{t('dashboard.title')}</span>
      <span data-testid="interp">{t('onboarding.stepProgress', { step: 2, total: 5 })}</span>
    </div>
  );
}

describe('i18n foundations', () => {
  afterEach(() => cleanup());

  it('resolves English strings and interpolates placeholders by default', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('title').textContent).toBe('Your farm operating system');
    expect(screen.getByTestId('interp').textContent).toBe('Step 2 of 5');
  });

  it('T island renders translated strings for server components', () => {
    render(
      <I18nProvider>
        <T k="nav.skipToContent" />
      </I18nProvider>
    );
    expect(screen.getByText('Skip to content')).toBeTruthy();
  });

  it('empty ha/yo/ig dictionaries fall back to English', () => {
    window.localStorage.setItem('agric.locale', 'ha');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByTestId('locale').textContent).toBe('ha');
    expect(screen.getByTestId('title').textContent).toBe('Your farm operating system');
    expect(document.documentElement.lang).toBe('ha');
  });

  it('switching locale persists to agric.locale and updates <html lang>', () => {
    render(
      <I18nProvider>
        <LocaleSwitcher id="locale-test" />
      </I18nProvider>
    );
    const select = screen.getByLabelText(/Language \/ Harshe/i) as HTMLSelectElement;
    act(() => {
      select.value = 'yo';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(window.localStorage.getItem('agric.locale')).toBe('yo');
    expect(document.documentElement.lang).toBe('yo');
  });

  it('ignores invalid stored locales', () => {
    window.localStorage.setItem('agric.locale', 'fr');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
  });
});
