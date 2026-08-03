import Link from 'next/link';
import type { Metadata } from 'next';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Page not found'
};

/**
 * Branded 404. Offline-aware copy: on a dropped connection the shell may
 * serve this for routes the service worker has never cached, so the copy
 * points at the offline page instead of implying the platform is broken.
 */
export default function NotFound() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">
          <T k="notFound.kicker" />
        </span>
        <h1>
          <T k="notFound.title" />
        </h1>
        <p className="muted">
          <T k="notFound.description" />
        </p>
      </header>
      <section className="section-tight">
        <div className="cluster">
          <Link href="/" className="btn btn-primary">
            <T k="notFound.home" />
          </Link>
          <Link href="/offline" className="btn btn-ghost">
            <T k="notFound.offline" />
          </Link>
        </div>
      </section>
    </div>
  );
}
