import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { Nav } from '@/components/nav';
import { ALL_PRODUCTS, MORE_LINKS, PRIMARY_LINKS } from '@/lib/products';

expect.extend(toHaveNoViolations);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderNav() {
  return render(
    <AppProvider>
      <I18nProvider>
        <Nav />
      </I18nProvider>
    </AppProvider>
  );
}

describe('nav restructure (Wave UIUX)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse({ data: [] })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('primary row stays compact (<=8 links) and exposes the /products hub', () => {
    expect(PRIMARY_LINKS.length).toBeLessThanOrEqual(8);
    renderNav();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    const links = primary.querySelectorAll('a');
    // primary links + the "All products" accent link
    expect(links.length).toBe(PRIMARY_LINKS.length + 1);
    expect(screen.getByRole('link', { name: 'All products' }).getAttribute('href')).toBe(
      '/products'
    );
  });

  it('overflow destinations are hidden behind the More menu, not the primary row', () => {
    renderNav();
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    // Direct href assertions are stronger than label lookups here.
    for (const link of MORE_LINKS) {
      const item = document.querySelector(`#nav-more-menu a[href="${link.href}"]`);
      expect(item, link.href).toBeTruthy();
    }
  });

  it('More button toggles aria-expanded and the menu carries an accessible name', () => {
    renderNav();
    const button = screen.getByRole('button', { name: 'More' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('More pages');
    // The hub is reachable from the menu as well.
    const hub = document.querySelector('#nav-more-menu a[href="/products"]');
    expect(hub).toBeTruthy();
  });

  it('Escape closes the menu and returns focus to the More button', () => {
    renderNav();
    const button = screen.getByRole('button', { name: 'More' });
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('every nav destination (primary + overflow) exists on the /products hub', () => {
    const hubHrefs = new Set(ALL_PRODUCTS.map((product) => product.href).filter(Boolean));
    for (const link of [...PRIMARY_LINKS, ...MORE_LINKS]) {
      // /dashboard is a destination of its own; everything else must be a hub card.
      if (link.href === '/dashboard') continue;
      expect(hubHrefs.has(link.href), `${link.href} missing from /products`).toBe(true);
    }
  });

  it('nav with the overflow menu open has no axe violations', async () => {
    const { container } = renderNav();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
