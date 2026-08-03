import Link from 'next/link';
import { T } from '@/lib/i18n';
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
            <T k="footer.tagline" />
          </p>
          <div style={{ marginTop: '1rem' }}>
            <LocaleSwitcher id="locale-footer" />
          </div>
        </div>
        <div>
          <div className="footer-title">
            <T k="footer.platform" />
          </div>
          <ul className="footer-links">
            <li><Link href="/products"><T k="nav.products" /></Link></li>
            <li><Link href="/dashboard"><T k="footer.dashboard" /></Link></li>
            <li><Link href="/learning"><T k="footer.learningAcademy" /></Link></li>
            <li><Link href="/opportunities"><T k="footer.opportunities" /></Link></li>
            <li><Link href="/marketplace"><T k="footer.marketplace" /></Link></li>
            <li><Link href="/services"><T k="footer.services" /></Link></li>
            <li><Link href="/programmes"><T k="footer.programmes" /></Link></li>
            <li><Link href="/pathways"><T k="footer.pathways" /></Link></li>
            <li><Link href="/knowledge"><T k="footer.knowledge" /></Link></li>
            <li><Link href="/advisory"><T k="footer.advisory" /></Link></li>
          </ul>
        </div>
        <div>
          <div className="footer-title">
            <T k="footer.organisation" />
          </div>
          <ul className="footer-links">
            <li><Link href="/chapters"><T k="footer.chapters" /></Link></li>
            <li><Link href="/community"><T k="footer.community" /></Link></li>
            <li><Link href="/partner"><T k="footer.partnerHub" /></Link></li>
            <li><Link href="/admin"><T k="footer.adminConsole" /></Link></li>
            <li><Link href="/integrations"><T k="footer.integrations" /></Link></li>
          </ul>
        </div>
        <div>
          <div className="footer-title">
            <T k="footer.trust" />
          </div>
          <ul className="footer-links">
            <li><Link href="/privacy"><T k="footer.privacy" /></Link></li>
            <li><Link href="/search"><T k="footer.search" /></Link></li>
            <li><Link href="/offline"><T k="footer.offlineMode" /></Link></li>
            <li><Link href="/settings"><T k="footer.settings" /></Link></li>
            <li><Link href="/onboarding"><T k="footer.joinNyfn" /></Link></li>
          </ul>
        </div>
      </div>
      <div className="container footer-bottom">
        <p>
          <T k="footer.bottomNote" />
        </p>
      </div>
    </footer>
  );
}
