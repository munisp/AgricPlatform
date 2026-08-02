import type { Metadata } from 'next';
import { SandboxKeyRequest } from './sandbox-key-request';

export const metadata: Metadata = {
  title: 'Get a sandbox key',
  description: 'Request an AgricPlatform sandbox API key — shown once, stored hashed.'
};

export default function SandboxKeyPage() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">Developers</span>
        <h1>Get a sandbox key</h1>
        <p className="muted">
          Sandbox keys call the same API surface with test data and the{' '}
          <code>ak_sandbox_</code> prefix. The key is shown <strong>exactly once</strong> — copy it
          somewhere safe; only its salted hash is stored.
        </p>
      </header>
      <section className="section-tight">
        <SandboxKeyRequest />
      </section>
    </div>
  );
}
