'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { USER_ROLES } from '@agric-platform/shared';
import type { UserRole } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useT } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import { ROLE_LABELS } from '@/lib/content';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { NotificationBell } from '@/components/notification-bell';

const TOP_LINKS: { href: string; labelKey: TranslationKey }[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard' },
  { href: '/learning', labelKey: 'nav.learning' },
  { href: '/community', labelKey: 'nav.community' },
  { href: '/opportunities', labelKey: 'nav.opportunities' },
  { href: '/chapters', labelKey: 'nav.chapters' },
  { href: '/marketplace', labelKey: 'nav.marketplace' },
  { href: '/livestock', labelKey: 'nav.livestock' },
  { href: '/farms', labelKey: 'nav.farms' },
  { href: '/agents', labelKey: 'nav.agents' },
  { href: '/finance', labelKey: 'nav.finance' },
  { href: '/credit', labelKey: 'nav.credit' },
  { href: '/advisory', labelKey: 'nav.advisory' },
  { href: '/partner', labelKey: 'nav.partner' },
  { href: '/admin', labelKey: 'nav.admin' }
];

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
            {TOP_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(pathname, link.href) ? 'page' : undefined}
              >
                {t(link.labelKey)}
              </Link>
            ))}
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
