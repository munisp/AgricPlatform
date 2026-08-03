'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { USER_ROLES } from '@agric-platform/shared';
import type { UserRole } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useT } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import { ROLE_LABELS } from '@/lib/content';
import { PRIMARY_LINKS, MORE_LINKS } from '@/lib/products';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { NotificationBell } from '@/components/notification-bell';

const TAB_LINKS: { href: string; labelKey: TranslationKey }[] = [
  { href: '/', labelKey: 'nav.tabHome' },
  { href: '/dashboard', labelKey: 'nav.dashboard' },
  { href: '/learning', labelKey: 'nav.tabLearn' },
  { href: '/opportunities', labelKey: 'nav.opportunities' },
  { href: '/marketplace', labelKey: 'nav.tabMarket' }
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Overflow ("More") menu for destinations that no longer fit the primary
 * row. Keyboard contract: button toggles, Escape closes and returns focus
 * to the button, tabbing out of the last link closes the menu.
 */
function OverflowMenu({ pathname }: { pathname: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return (
    <div className="nav-overflow" ref={rootRef}>
      <button
        type="button"
        className="nav-more"
        ref={buttonRef}
        aria-expanded={open}
        aria-controls="nav-more-menu"
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {t('nav.more')}
      </button>
      {open ? (
        <div
          className="nav-menu"
          id="nav-more-menu"
          role="menu"
          aria-label={t('nav.moreMenuLabel')}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
          }}
        >
          {MORE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              aria-current={isActive(pathname, link.href) ? 'page' : undefined}
            >
              {t(link.labelKey)}
            </Link>
          ))}
          <Link
            href="/products"
            role="menuitem"
            className="nav-menu-hub"
            aria-current={isActive(pathname, '/products') ? 'page' : undefined}
          >
            {t('nav.products')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function Nav() {
  const pathname = usePathname() ?? '/';
  const { role, setRole, hydrated } = useAppState();
  const { t } = useT();

  return (
    <>
      <header className="site-header">
        <div className="container site-header-inner">
          <Link href="/" className="brand" aria-label={t('nav.home')}>
            <span className="leaf-mark" aria-hidden="true" />
            AgricPlatform
          </Link>
          <nav className="nav-links" aria-label={t('nav.primaryNav')}>
            {PRIMARY_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(pathname, link.href) ? 'page' : undefined}
              >
                {t(link.labelKey)}
              </Link>
            ))}
            <Link
              href="/products"
              className="nav-products"
              aria-current={isActive(pathname, '/products') ? 'page' : undefined}
            >
              {t('nav.products')}
            </Link>
            <OverflowMenu pathname={pathname} />
          </nav>
          <div className="nav-actions">
            {/* Wave P: live notification bell (SSE with polling fallback). */}
            <NotificationBell />
            <LocaleSwitcher id="locale-nav" />
            <Link href="/search" className="btn btn-ghost btn-small" aria-label={t('nav.searchLabel')}>
              {t('nav.search')}
            </Link>
            {/* Dev-only role preview: the API ignores x-user-id when
                NODE_ENV === 'production', so the pill is hidden there too. */}
            {process.env.NODE_ENV !== 'production' ? (
            <span
              className="role-pill"
              title="Development preview: switch between seeded dev users (x-user-id header). Not available in production."
            >
              <span aria-hidden="true">●</span>
              <span className="small muted" aria-hidden="true">
                dev
              </span>
              <label className="small sr-only" htmlFor="role-select">
                {t('nav.rolePreview')}
              </label>
              <select
                id="role-select"
                value={role}
                disabled={!hydrated}
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                {USER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </span>
            ) : null}
          </div>
        </div>
      </header>
      <nav className="bottom-nav" aria-label={t('nav.mobileNav')}>
        {TAB_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(pathname, link.href) ? 'page' : undefined}
          >
            <span className="tab-icon" aria-hidden="true" />
            {t(link.labelKey)}
          </Link>
        ))}
      </nav>
    </>
  );
}
