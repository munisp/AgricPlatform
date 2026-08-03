import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatNaira } from '@agric-platform/shared';
import type { IntegrationStatus, PlatformMetric } from '@agric-platform/shared';

/** Display-only kobo → naira formatting (money math itself stays in kobo). */
export function formatKobo(kobo: number): string {
  return formatNaira(kobo / 100);
}

export type Tone = 'success' | 'warning' | 'critical' | 'info' | 'neutral';

export function PageHeader({
  kicker,
  title,
  description,
  children
}: {
  kicker: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <span className="kicker">{kicker}</span>
      {/* tabIndex -1 makes the heading a programmatic focus target (route
          changes / skip flows) without adding it to the tab order. */}
      <h1 tabIndex={-1}>{title}</h1>
      {description ? <p className="muted">{description}</p> : null}
      {children}
    </header>
  );
}

export function Section({
  id,
  kicker,
  title,
  description,
  children
}: {
  id?: string;
  kicker?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    // aria-label only when the title is a plain string; translated titles
    // (<T> nodes) rely on the h2 for heading navigation.
    <section
      className="section"
      id={id}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div className="section-head">
        {kicker ? <span className="kicker">{kicker}</span> : null}
        <h2>{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Card({
  title,
  children,
  className
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`card${className ? ` ${className}` : ''}`}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </article>
  );
}

export function StatusBadge({
  tone,
  children,
  ariaLabel
}: {
  tone: Tone;
  children: ReactNode;
  /** Clarifying accessible name when the badge text alone is ambiguous. */
  ariaLabel?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} aria-label={ariaLabel}>
      {children}
    </span>
  );
}

const toneByKeyword: Record<string, Tone> = {
  active: 'success',
  verified: 'success',
  delivered: 'success',
  successful: 'success',
  completed: 'success',
  matched: 'success',
  info: 'info',
  sent: 'info',
  submitted: 'info',
  confirmed: 'info',
  warning: 'warning',
  queued: 'warning',
  under_review: 'warning',
  uploaded: 'warning',
  requested: 'warning',
  negotiating: 'warning',
  deposit_paid: 'warning',
  in_fulfilment: 'warning',
  reporting: 'warning',
  critical: 'critical',
  failed: 'critical',
  rejected: 'critical',
  disputed: 'critical',
  cancelled: 'critical',
  unsuccessful: 'neutral',
  withdrawn: 'neutral',
  closed: 'neutral',
  draft: 'neutral'
};

export function AutoBadge({ value, ariaLabel }: { value: string; ariaLabel?: string }) {
  const tone = toneByKeyword[value] ?? 'neutral';
  return (
    <StatusBadge tone={tone} ariaLabel={ariaLabel}>
      {value.replace(/_/g, ' ')}
    </StatusBadge>
  );
}

export function MetricCard({ metric }: { metric: PlatformMetric }) {
  const trendUp = (metric.trend ?? 0) >= 0;
  return (
    <div className="metric-card">
      <div className="metric-value">
        {metric.value.toLocaleString('en-NG')}
        {metric.unit ? <span className="small muted"> {metric.unit}</span> : null}
      </div>
      <div className="metric-label">{metric.label}</div>
      {typeof metric.trend === 'number' ? (
        <div className={`metric-trend${trendUp ? '' : ' down'}`}>
          <span aria-hidden="true">{trendUp ? '▲' : '▼'}</span>
          <span className="sr-only">{trendUp ? 'up' : 'down'}</span> {Math.abs(metric.trend)}% this
          quarter
        </div>
      ) : null}
    </div>
  );
}

export function MetricsGrid({ metrics }: { metrics: PlatformMetric[] }) {
  return (
    <div className="grid grid-3">
      {metrics.map((metric) => (
        <MetricCard key={metric.key} metric={metric} />
      ))}
    </div>
  );
}

export function ModuleCard({
  href,
  title,
  description,
  tag
}: {
  href: string;
  title: string;
  description: string;
  tag: string;
}) {
  return (
    <Link className="module-card" href={href}>
      <span className="module-glyph" aria-hidden="true" />
      <span className="module-title">{title}</span>
      <span className="module-desc">{description}</span>
      <span className="module-tag">{tag} →</span>
    </Link>
  );
}

export interface TimelineItem {
  id: string;
  title: string;
  date?: string;
  description?: string;
  tone?: 'default' | 'warning' | 'clay';
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li className="timeline-item" key={item.id}>
          <span
            className={`timeline-dot${item.tone && item.tone !== 'default' ? ` ${item.tone}` : ''}`}
            aria-hidden="true"
          />
          <div className="timeline-title">{item.title}</div>
          {item.date ? <div className="timeline-date">{item.date}</div> : null}
          {item.description ? <p className="muted small">{item.description}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      {label ? (
        <div className="cluster" style={{ justifyContent: 'space-between' }}>
          <span className="small soft">{label}</span>
          <span className="small" style={{ fontWeight: 700 }}>
            {clamped}%
          </span>
        </div>
      ) : null}
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
      >
        <div className="progress-fill" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

export function IntegrationCard({ integration }: { integration: IntegrationStatus }) {
  const driverTone: Tone =
    integration.driver === 'production' ? 'success' : integration.driver === 'sandbox' ? 'info' : 'neutral';
  return (
    <article className="card integration-card">
      <div className="integration-head">
        <h3 style={{ margin: 0 }}>{integration.provider}</h3>
        <StatusBadge tone={driverTone}>{integration.driver}</StatusBadge>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {integration.capability}
      </p>
      <div className="cluster">
        <span className={`health-dot${integration.healthy ? ' ok' : ' bad'}`}>
          {integration.healthy ? 'Healthy' : 'Not ready'}
        </span>
        <span className="small muted">
          {integration.configured ? 'Configured' : 'Awaiting credentials'}
        </span>
      </div>
      {integration.notes ? <p className="small muted">{integration.notes}</p> : null}
    </article>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{title}</p>
      {hint ? <p className="small">{hint}</p> : null}
    </div>
  );
}
