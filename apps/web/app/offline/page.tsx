import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Offline'
};

export default function OfflinePage() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">Offline mode</span>
        <h1>You are offline — no problem.</h1>
        <p className="muted">
          AgricPlatform keeps working without connectivity. Pages you have visited are cached on this
          device, and anything you submit is queued locally and syncs when you reconnect.
        </p>
      </header>
      <section className="section-tight">
        <div className="notice" role="status">
          <strong>Queued submissions stay safe.</strong> Applications, listings, attendance records and
          privacy requests are stored on this device with idempotency keys until they can be sent.
        </div>
      </section>
      <section className="section-tight">
        <div className="cluster">
          <Link href="/" className="btn btn-primary">
            Retry connection
          </Link>
          <Link href="/dashboard" className="btn btn-ghost">
            Open cached dashboard
          </Link>
        </div>
      </section>
    </div>
  );
}
