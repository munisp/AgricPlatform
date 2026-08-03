'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchVoiceAgentCases, type VoiceAgentCase } from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { QueryState } from '@/components/api-state';
import { CheckRow, Select } from '@/components/forms';
import { EmptyState, StatusBadge } from '@/components/ui';

type QueueFilter = 'needs' | 'all';

function statusTone(status: VoiceAgentCase['status']) {
  if (status === 'open') return 'critical' as const;
  if (status === 'assigned') return 'warning' as const;
  if (status === 'responded') return 'info' as const;
  return 'success' as const;
}

/** Whole-hour age label for a SLA deadline relative to `now`. */
export function slaAgeLabel(slaDueAt: string, now: number): { text: string; overdue: boolean } {
  const diffMs = new Date(slaDueAt).getTime() - now;
  const hours = Math.round(Math.abs(diffMs) / 3_600_000);
  if (diffMs < 0) {
    return { text: `${hours}h overdue`, overdue: true };
  }
  return { text: `due in ${hours}h`, overdue: false };
}

/**
 * Agent-assist queue (wave VOICE): escalation cases from the voice
 * agronomist, ordered by SLA deadline. Honest states: loading skeleton,
 * mapped API errors, and a real empty state — no fixture data is ever shown
 * for the queue.
 */
export function AgentAssistQueue() {
  const { t } = useT();
  const [filter, setFilter] = useState<QueueFilter>('needs');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const query = useApiQuery(
    `voice:agent-cases:${filter}:${overdueOnly}`,
    () =>
      fetchVoiceAgentCases({ overdue: overdueOnly || undefined }).then((res) => res.data),
    { staleTimeMs: 15_000 }
  );

  const cases = (query.data ?? []).filter((entry) =>
    filter === 'needs' ? entry.status === 'open' || entry.status === 'assigned' : true
  );
  // Snapshot once per mount so render stays pure; SLA ages refresh on reload.
  const [now] = useState(() => Date.now());

  return (
    <div className="stack">
      <div className="cluster" role="group" aria-label={t('voice.queueTitle')}>
        <Select
          aria-label={t('voice.statusLabel')}
          value={filter}
          onChange={(event) => setFilter(event.target.value as QueueFilter)}
        >
          <option value="needs">{t('voice.openStatuses')}</option>
          <option value="all">{t('voice.allStatuses')}</option>
        </Select>
        <CheckRow
          id="voice-overdue-only"
          checked={overdueOnly}
          onChange={setOverdueOnly}
          label={t('voice.overdueOnly')}
        />
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title={t('voice.queueEmpty')} />}
      >
        {cases.length === 0 ? (
          <EmptyState title={t('voice.queueEmpty')} />
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {cases.map((entry) => {
              const sla = slaAgeLabel(entry.slaDueAt, now);
              return (
                <li key={entry.id} className="card">
                  <div className="cluster">
                    <StatusBadge tone={statusTone(entry.status)}>{entry.status}</StatusBadge>
                    <StatusBadge tone="neutral" ariaLabel={`${t('voice.channelLabel')}: ${entry.channel}`}>
                      {entry.channel}
                    </StatusBadge>
                    {entry.priority === 'high' ? (
                      <StatusBadge tone="warning">{entry.priority}</StatusBadge>
                    ) : null}
                    {sla.overdue ? (
                      <StatusBadge tone="critical">{t('voice.overdueBadge')}</StatusBadge>
                    ) : null}
                  </div>
                  <p className="small soft">
                    {t('voice.reasonLabel')}: {entry.reason} · {t('voice.phoneLabel')}: {entry.phone}
                  </p>
                  <p className="small soft">
                    {t('voice.slaAgeLabel')}: {sla.text} ·{' '}
                    {entry.assignedAgentId
                      ? `${t('voice.assignedLabel')}: ${entry.assignedAgentId}`
                      : t('voice.unassigned')}
                  </p>
                  <Link href={`/agent-assist/${entry.id}`} className="btn btn-ghost btn-small">
                    {t('voice.caseTitle')} →
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
