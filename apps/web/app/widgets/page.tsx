import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'Embeddable widgets',
  description:
    'Framework-free AgricPlatform widgets: opportunity directory, commodity price ticker, course catalogue and the NYFN member button.'
};

const SNIPPETS = [
  {
    id: 'opportunities',
    title: 'Opportunity directory',
    target: 'demo-opportunities',
    snippet:
      '<div id="agric-opps"></div>\n' +
      '<script src="https://app.agricplatform.ng/widgets/opportunities.js"\n' +
      '        data-target="#agric-opps" defer></script>'
  },
  {
    id: 'prices',
    title: 'Commodity price ticker',
    target: 'demo-prices',
    snippet:
      '<div id="agric-prices"></div>\n' +
      '<script src="https://app.agricplatform.ng/widgets/prices.js"\n' +
      '        data-target="#agric-prices" defer></script>'
  },
  {
    id: 'courses',
    title: 'Course catalogue',
    target: 'demo-courses',
    snippet:
      '<div id="agric-courses"></div>\n' +
      '<script src="https://app.agricplatform.ng/widgets/courses.js"\n' +
      '        data-target="#agric-courses" defer></script>'
  },
  {
    id: 'member-button',
    title: 'Register as NYFN Member button',
    target: 'demo-member-button',
    snippet:
      '<div id="agric-join"></div>\n' +
      '<script src="https://app.agricplatform.ng/widgets/member-button.js"\n' +
      '        data-target="#agric-join" defer></script>'
  }
];

/**
 * Live demo + copy-paste snippets. Widgets are plain script bundles served
 * from /public/widgets — no iframes; they call the anonymous, CORS-open
 * /api/v1/embed/* feeds (no PII, 60s cache).
 */
export default function WidgetsPage() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">Developers</span>
        <h1>Embeddable widgets</h1>
        <p className="muted">
          Drop a script tag on any page to surface live platform data. Framework-free, under 15KB
          each, no iframes, no cookies. Override the API origin with{' '}
          <code>data-api=&quot;https://api.example/api/v1&quot;</code>.
        </p>
      </header>

      {SNIPPETS.map((widget) => (
        <section key={widget.id} className="section-tight">
          <h2>{widget.title}</h2>
          <div id={widget.target} className="card" data-testid={`widget-${widget.id}`}>
            Loading…
          </div>
          <details>
            <summary>Embed snippet</summary>
            <pre>
              <code>{widget.snippet}</code>
            </pre>
          </details>
          <Script
            src={`/widgets/${widget.id}.js`}
            data-target={`#${widget.target}`}
            strategy="afterInteractive"
          />
        </section>
      ))}
    </div>
  );
}
