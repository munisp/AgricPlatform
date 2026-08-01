import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppProvider } from '@/lib/app-state';
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
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'AgricPlatform'
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
          <a className="skip-link" href="#main-content">
            Skip to content
          </a>
          <Nav />
          <main className="main" id="main-content" tabIndex={-1}>
            {children}
          </main>
          <Footer />
          <ServiceWorkerRegister />
        </AppProvider>
      </body>
    </html>
  );
}
