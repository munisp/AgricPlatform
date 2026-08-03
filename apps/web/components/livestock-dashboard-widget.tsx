'use client';

import Link from 'next/link';
import type { Animal } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import { listDueVaccinations, listMyAnimals, listRecalls } from '@/lib/api/endpoints';
import { ForbiddenError } from '@/lib/api/errors';
import { demoLivestockSummary } from '@/lib/content';
import { Card, StatusBadge } from '@/components/ui';
import { OfflineDataNotice } from '@/components/api-state';

export interface LivestockSummary {
  total: number;
  bySpecies: Array<{ species: string; count: number }>;
  /** Vaccinations due or overdue (from /livestock-health/vaccinations/due). */
  pendingHealthTasks: number;
  /** Overdue subset of pendingHealthTasks. */
  overdueHealthTasks: number;
  /** Non-resolved recalls, or null when recalls are not visible to this role. */
  openRecalls: number | null;
}

/** Exported for tests — computes the summary from live registry + health data. */
export async function summariseLivestock(animals: Animal[]): Promise<LivestockSummary> {
  const alive = animals.filter((animal) => animal.status === 'alive');
  const counts = new Map<string, number>();
  for (const animal of alive) {
    counts.set(animal.species, (counts.get(animal.species) ?? 0) + 1);
  }

  // Pending health tasks come from the computed due-vaccination schedule
  // (server derives due = last vaccination + interval per scheduled vaccine).
  let pendingHealthTasks = 0;
  let overdueHealthTasks = 0;
  try {
    const due = await listDueVaccinations({ days: 30 }).then((res) => res.data);
    const pending = due.filter((item) => item.status !== 'upcoming');
    pendingHealthTasks = pending.length;
    overdueHealthTasks = pending.filter((item) => item.status === 'overdue').length;
  } catch {
    // Schedule not visible to this caller — leave the counts at zero rather
    // than fabricating pending tasks.
  }

  let openRecalls: number | null = null;
  try {
    const recalls = await listRecalls().then((res) => res.data);
    openRecalls = recalls.filter((recall) => recall.status !== 'resolved').length;
  } catch (error) {
    // Recall listing is regulator/admin only — farmers see '—' instead of a count.
    if (!(error instanceof ForbiddenError)) throw error;
  }

  return {
    total: alive.length,
    bySpecies: [...counts.entries()].map(([species, count]) => ({ species, count })),
    pendingHealthTasks,
    overdueHealthTasks,
    openRecalls
  };
}

/**
 * Livestock summary card for the farmer dashboard — animal count by species,
 * open recalls and pending health tasks. Hidden for non-farmer personas.
 */
export function LivestockSummaryCard() {
  const { role, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated && role === 'farmer' ? 'livestock:dashboard-summary' : null,
    () => listMyAnimals().then((res) => res.data).then(summariseLivestock),
    // Offline fallback only — live data from GET /api/v1/livestock/animals/mine.
    { fallbackData: demoLivestockSummary, enabled: hydrated && role === 'farmer' }
  );

  if (role !== 'farmer') return null;
  const summary = query.data;

  return (
    <Card title="Livestock summary">
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      {!summary && query.isLoading ? (
        <p className="small muted">Loading livestock summary…</p>
      ) : summary ? (
        <>
          <p style={{ fontWeight: 800, fontSize: '1.4rem', margin: 0 }}>
            {summary.total} <span className="small muted">live animals</span>
          </p>
          <p className="small muted" style={{ marginTop: '0.25rem' }}>
            {summary.bySpecies.map((entry) => `${entry.count} ${entry.species}`).join(' · ') ||
              'No live animals registered'}
          </p>
          <div className="cluster" style={{ marginTop: '0.5rem' }}>
            <StatusBadge
              tone={summary.pendingHealthTasks > 0 ? 'warning' : 'success'}
              ariaLabel={`${summary.pendingHealthTasks} vaccinations due or overdue`}
            >
              {summary.pendingHealthTasks} pending health task
              {summary.pendingHealthTasks === 1 ? '' : 's'}
              {summary.overdueHealthTasks > 0 ? ` (${summary.overdueHealthTasks} overdue)` : ''}
            </StatusBadge>
            {summary.openRecalls === null ? (
              <StatusBadge tone="neutral" ariaLabel="Open recalls are only visible to regulators">
                recalls: regulator only
              </StatusBadge>
            ) : (
              <StatusBadge
                tone={summary.openRecalls > 0 ? 'critical' : 'success'}
                ariaLabel={`${summary.openRecalls} open recalls`}
              >
                {summary.openRecalls} open recall{summary.openRecalls === 1 ? '' : 's'}
              </StatusBadge>
            )}
          </div>
          <p className="small" style={{ marginTop: '0.5rem' }}>
            <Link href="/livestock">Open the livestock registry →</Link>
          </p>
        </>
      ) : (
        <p className="small muted">Livestock summary unavailable.</p>
      )}
    </Card>
  );
}
