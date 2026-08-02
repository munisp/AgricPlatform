import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Developers',
  description:
    'Build on the AgricPlatform partner API: sandbox keys, endpoint catalogue, integration guides and embeddable widgets.'
};

export default function DevelopersLandingPage() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">Partner API</span>
        <h1>Build on AgricPlatform</h1>
        <p className="muted">
          One API for Nigeria&apos;s farmer platform: consented member data, programme metrics,
          marketplace and learning rails — for DFIs, lenders, NGOs and agri-businesses.
        </p>
      </header>

      <section className="section-tight">
        <div className="cluster">
          <Link href="/developers/sandbox" className="btn btn-primary">
            Get a sandbox key
          </Link>
          <Link href="/developers/docs" className="btn btn-ghost">
            Read the API docs
          </Link>
          <Link href="/widgets" className="btn btn-ghost">
            Embed a widget
          </Link>
        </div>
      </section>

      <section className="section-tight">
        <h2>Start in minutes</h2>
        <ol>
          <li>
            <strong>Get a sandbox API key.</strong> Keys are shown exactly once and stored hashed —
            keep yours in a secrets manager.
          </li>
          <li>
            <strong>Install the SDK.</strong> <code>npm install @agric-platform/sdk</code> —
            fetch-based, Node 18+ and browsers, typed resources, automatic retries and idempotency
            keys.
          </li>
          <li>
            <strong>Call the sandbox.</strong> The SDK defaults to the sandbox base URL; flip one
            option to go live.
          </li>
        </ol>
      </section>

      <section className="section-tight">
        <h2>What you can build</h2>
        <ul>
          <li>
            <strong>DFI impact pull</strong> — aggregate programme metrics and signed disbursement
            webhooks.
          </li>
          <li>
            <strong>Lender credit check</strong> — consented member profiles and training history.
          </li>
          <li>
            <strong>NGO enrolment push</strong> — programme enrolments and farmOS-compatible farm
            data.
          </li>
        </ul>
        <p>
          <Link href="/developers/guides">See the integration guides →</Link>
        </p>
      </section>

      <section className="section-tight">
        <h2>Fair use</h2>
        <p className="muted">
          Partner clients are limited to 1,000 requests per minute (token bucket; short bursts up
          to the full minute&apos;s allowance are absorbed, then throttled to the sustained rate).
          Member-level reads require an active <code>partner_data_sharing</code> consent — the API
          answers 403 otherwise.
        </p>
      </section>
    </div>
  );
}
