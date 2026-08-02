import Link from 'next/link';
import { LocaleSwitcher } from '@/components/locale-switcher';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <div className="brand" style={{ color: '#fff' }}>
            <span className="leaf-mark" aria-hidden="true" />
            AgricPlatform
          </div>
          <p className="small" style={{ marginTop: '0.75rem', maxWidth: '34ch' }}>
            The unified digital operating system for Nigeria&apos;s young farmers — built with NYFN for
            farmers, students, buyers, suppliers, chapters and partners.
          </p>
          <div style={{ marginTop: '1rem' }}>
            <LocaleSwitcher id="locale-footer" />
          </div>
        </div>
        <div>
          <div className="footer-title">Platform</div>
          <ul className="footer-links">
            <li><Link href="/dashboard">Dashboard</Link></li>
            <li><Link href="/learning">Learning Academy</Link></li>
            <li><Link href="/opportunities">Opportunities</Link></li>
            <li><Link href="/marketplace">Marketplace</Link></li>
            <li><Link href="/advisory">Advisory</Link></li>
          </ul>
        </div>
        <div>
          <div className="footer-title">Organisation</div>
          <ul className="footer-links">
            <li><Link href="/chapters">Chapters</Link></li>
            <li><Link href="/community">Community</Link></li>
            <li><Link href="/partner">Partner Hub</Link></li>
            <li><Link href="/admin">Admin Console</Link></li>
            <li><Link href="/integrations">Integrations</Link></li>
          </ul>
        </div>
        <div>
          <div className="footer-title">Trust</div>
          <ul className="footer-links">
            <li><Link href="/privacy">Privacy &amp; NDPR</Link></li>
            <li><Link href="/search">Search</Link></li>
            <li><Link href="/offline">Offline mode</Link></li>
            <li><Link href="/onboarding">Join NYFN</Link></li>
          </ul>
        </div>
      </div>
      <div className="container footer-bottom">
        <p>
          Phase 1 reference build · English, Hausa, Yoruba and Igbo language structure · Works offline —
          submissions queue on your device and sync when you reconnect.
        </p>
      </div>
    </footer>
  );
}
