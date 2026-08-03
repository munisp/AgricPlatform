import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider, T } from '@/lib/i18n';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { ServiceWorkerRegister } from '@/components/sw-register';

export const metadata: Metadata = {
  metadataBase: new URL('https://app.agricplatform.ng'),
  title: {
    default: 'AgricPlatform — Nigeria Farmer Platform',
    template: '%s · AgricPlatform'
  },
  description:
    'The unified digital operating system for NYFN stakeholders: onboarding, learning, community, opportunities, chapters, advisory, marketplace, finance and privacy — online and offline.',
  applicationName: 'AgricPlatform',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }
    ],
    // iOS cannot use SVG touch icons — real raster asset generated from icon.svg.
    apple: '/apple-touch-icon.png'
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'AgricPlatform'
  },
  other: {
    // Next 16 emits the standard `mobile-web-app-capable` for
    // appleWebApp.capable but not the legacy prefixed name that older iOS
    // Safari standalone mode still keys on — declare it explicitly.
    'apple-mobile-web-app-capable': 'yes'
  },
  formatDetection: { telephone: false }
};

export const viewport: Viewport = {
  themeColor: '#2f5d3f',
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <AppProvider>
          <I18nProvider>
            <a className="skip-link" href="#main-content">
              <T k="nav.skipToContent" />
            </a>
            <Nav />
            <main className="main" id="main-content" tabIndex={-1}>
              {children}
            </main>
            <Footer />
            <ServiceWorkerRegister />
          </I18nProvider>
        </AppProvider>
      </body>
    </html>
  );
}
