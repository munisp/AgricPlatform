'use client';

import { useMemo } from 'react';
import { seedChapters } from '@agric-platform/shared';
import type { ChapterEvent } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { listChapterEvents, listChapters, rsvpToEvent } from '@/lib/api/endpoints';
import { demoEvents } from '@/lib/content';
import { Card, StatusBadge } from '@/components/ui';
import { AttendanceQr } from '@/components/attendance-code';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/chapters and
// GET /api/v1/chapters/:id/events.
const FALLBACK_CHAPTERS = seedChapters;
const FALLBACK_EVENTS: ChapterEvent[] = demoEvents;

export function ChapterNetwork() {
  const query = useApiQuery(
    'chapters:list',
    () => listChapters({ pageSize: 100 }).then((res) => res.data),
    { fallbackData: FALLBACK_CHAPTERS }
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <ul className="row-list">
          {(query.data ?? []).map((chapter) => (
            <li className="row-item" key={chapter.id}>
              <div className="row-main">
                <div className="row-title">{chapter.name}</div>
                <div className="small muted">
                  {chapter.level} · {chapter.state}
                  {chapter.parentId ? ' · reports to national' : ''}
                </div>
              </div>
              <span className="small" style={{ fontWeight: 700 }}>
                {chapter.memberCount.toLocaleString('en-NG')} members
              </span>
              <StatusBadge tone={chapter.active ? 'success' : 'neutral'}>
                {chapter.active ? 'active' : 'inactive'}
              </StatusBadge>
            </li>
          ))}
        </ul>
      </QueryState>
    </>
  );
}

function EventCard({ event }: { event: ChapterEvent }) {
  const { userId } = useAppState();
  const rsvpMutation = useApiMutation<void, unknown>({
    mutationFn: () => rsvpToEvent(event.id, userId).then((res) => res.data),
    queue: {
      kind: 'chapter.event.rsvp',
      label: () => `RSVP: ${event.title}`,
      method: 'POST',
      path: () => `/events/${event.id}/rsvp`,
      payload: () => ({ userId })
    }
  });

  return (
    <Card title={event.title}>
      <p className="small muted">
        {event.type.replace(/_/g, ' ')} · {event.location}
      </p>
      <p className="small">
        {new Date(event.startsAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })}
      </p>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <StatusBadge tone="info">{event.rsvpCount} RSVPs</StatusBadge>
        <span className="cluster">
          {rsvpMutation.status === 'success' ? (
            <StatusBadge tone="success">RSVP confirmed</StatusBadge>
          ) : rsvpMutation.status === 'queued' ? (
            <StatusBadge tone="warning">RSVP queued</StatusBadge>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={rsvpMutation.status === 'pending'}
              onClick={() => void rsvpMutation.mutate()}
            >
              {rsvpMutation.status === 'pending' ? 'Sending…' : 'RSVP'}
            </button>
          )}
          <AttendanceQr eventId={event.id} />
        </span>
      </div>
      {rsvpMutation.status === 'error' ? <ApiErrorNotice error={rsvpMutation.error} /> : null}
    </Card>
  );
}

export function ChapterEvents() {
  const { hydrated } = useAppState();
  const chaptersQuery = useApiQuery(
    'chapters:list',
    () => listChapters({ pageSize: 100 }).then((res) => res.data),
    { fallbackData: FALLBACK_CHAPTERS, enabled: hydrated }
  );

  const chapterIds = useMemo(
    () => (chaptersQuery.data ?? []).slice(0, 3).map((chapter) => chapter.id),
    [chaptersQuery.data]
  );

  const eventsQuery = useApiQuery(
    hydrated && chapterIds.length > 0 ? `chapters:events:${chapterIds.join(',')}` : null,
    async () => {
      const batches = await Promise.all(
        chapterIds.map((id) => listChapterEvents(id).then((res) => res.data))
      );
      return batches
        .flat()
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },
    { fallbackData: FALLBACK_EVENTS, enabled: hydrated }
  );

  return (
    <>
      {eventsQuery.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={eventsQuery.isLoading}
        error={eventsQuery.source === 'fallback' ? undefined : eventsQuery.error}
        data={eventsQuery.data}
        onRetry={eventsQuery.refresh}
      >
        <div className="grid grid-3">
          {(eventsQuery.data ?? []).map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      </QueryState>
    </>
  );
}
