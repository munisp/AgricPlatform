import Link from 'next/link';
import type { Metadata } from 'next';
import { OPENAPI_CATALOGUE } from '@/lib/openapi-catalogue';

export const metadata: Metadata = {
  title: 'API documentation',
  description: 'Endpoint catalogue for the AgricPlatform partner API.'
};

const AUTH_LABELS: Record<string, string> = {
  'client-credentials': 'M2M access token',
  'api-key': 'API key or M2M token',
  'user-token': 'Signed-in user',
  none: 'Anonymous'
};

export default function DeveloperDocsPage() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">Developers</span>
        <h1>API documentation</h1>
        <p className="muted">
          Endpoint catalogue for the partner API. All routes are versioned under{' '}
          <code>/api/v1</code>. Authenticate with a client-credentials access token (
          <code>Authorization: Bearer …</code>) or a developer API key (<code>x-api-key: …</code>).
        </p>
      </header>

      <nav className="section-tight" aria-label="Sections">
        <ul className="cluster">
          {OPENAPI_CATALOGUE.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ul>
      </nav>

      {OPENAPI_CATALOGUE.map((section) => (
        <section key={section.id} id={section.id} className="section-tight">
          <h2>{section.title}</h2>
          <p className="muted">{section.description}</p>
          {section.endpoints.map((endpoint) => (
            <article key={`${endpoint.method} ${endpoint.path}`} className="card">
              <h3>
                <code>
                  {endpoint.method} {endpoint.path}
                </code>
              </h3>
              <p>{endpoint.summary}</p>
              <dl>
                <dt>Auth</dt>
                <dd>{AUTH_LABELS[endpoint.auth]}</dd>
                {endpoint.scopes ? (
                  <>
                    <dt>Scopes</dt>
                    <dd>
                      {endpoint.scopes.map((scope) => (
                        <code key={scope}>{scope}</code>
                      ))}
                    </dd>
                  </>
                ) : null}
                {endpoint.requestBody ? (
                  <>
                    <dt>Request body</dt>
                    <dd>
                      <code>{endpoint.requestBody}</code>
                    </dd>
                  </>
                ) : null}
                <dt>Response</dt>
                <dd>
                  <code>{endpoint.response}</code>
                </dd>
              </dl>
            </article>
          ))}
        </section>
      ))}

      <section className="section-tight">
        <p className="muted">
          Prefer a typed client? <Link href="/developers/guides">Use the SDK guides</Link> or grab a{' '}
          <Link href="/developers/sandbox">sandbox key</Link>.
        </p>
      </section>
    </div>
  );
}
