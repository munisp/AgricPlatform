'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { USER_ROLES } from '@agric-platform/shared';
import type { UserRole } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { ROLE_LABELS } from '@/lib/content';

const TOP_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/learning', label: 'Learning' },
  { href: '/community', label: 'Community' },
  { href: '/opportunities', label: 'Opportunities' },
  { href: '/chapters', label: 'Chapters' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/finance', label: 'Finance' },
  { href: '/advisory', label: 'Advisory' },
  { href: '/partner', label: 'Partner' },
  { href: '/admin', label: 'Admin' }
];

const TAB_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/learning', label: 'Learn' },
  { href: '/opportunities', label: 'Opportunities' },
  { href: '/marketplace', label: 'Market' }
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav() {
  const pathname = usePathname() ?? '/';
  const { role, setRole, hydrated } = useAppState();

  return (
    <>
      <header className="site-header">
        <div className="container site-header-inner">
          <Link href="/" className="brand" aria-label="AgricPlatform home">
            <span className="leaf-mark" aria-hidden="true" />
            AgricPlatform
          </Link>
          <nav className="nav-links" aria-label="Primary">
            {TOP_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(pathname, link.href) ? 'page' : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="nav-actions">
            <Link href="/search" className="btn btn-ghost btn-small" aria-label="Search the platform">
              Search
            </Link>
            <span className="role-pill" title="Preview the platform as a role">
              <span aria-hidden="true">●</span>
              <label className="small" style={{ position: 'absolute', left: '-9999px' }} htmlFor="role-select">
                View as role
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
          </div>
        </div>
      </header>
      <nav className="bottom-nav" aria-label="Mobile">
        {TAB_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(pathname, link.href) ? 'page' : undefined}
          >
            <span className="tab-icon" aria-hidden="true" />
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
