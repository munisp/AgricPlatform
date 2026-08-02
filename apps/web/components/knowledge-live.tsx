'use client';

import { useState } from 'react';
import { KNOWLEDGE_FORMATS } from '@agric-platform/shared';
import type {
  KnowledgeFormat,
  KnowledgeResource,
  LanguageCode,
  PodcastEpisode,
  Webinar
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  listKnowledgeResources,
  listMyWebinarRegistrations,
  listPodcastEpisodes,
  listWebinars,
  registerForWebinar
} from '@/lib/api/endpoints';
import { CheckRow, Field, Select, TextInput } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, StatusBadge } from '@/components/ui';

const LANGUAGES: { code: LanguageCode; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ha', label: 'Hausa' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ig', label: 'Igbo' }
];

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

/* --------------------------- resource library --------------------------- */

function ResourceCard({ resource }: { resource: KnowledgeResource }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title={resource.title}>
      <p className="small muted">
        {resource.format} · {resource.tags.join(', ') || 'general'} ·{' '}
        {resource.viewCount.toLocaleString('en-NG')} views
      </p>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span className="cluster">
          <AutoBadge value={resource.format} />
          {resource.offlineAvailable ? (
            <StatusBadge tone="success">offline-ready</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">online only</StatusBadge>
          )}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? 'Close' : 'Read'}
        </button>
      </div>
      {open ? (
        <article className="resource-body" style={{ marginTop: '0.5rem' }}>
          <p>{resource.body}</p>
        </article>
      ) : null}
    </Card>
  );
}

export function ResourceLibrary() {
  const [tag, setTag] = useState('');
  const [language, setLanguage] = useState<'' | LanguageCode>('');
  const [format, setFormat] = useState<'' | KnowledgeFormat>('');
  const [offlineOnly, setOfflineOnly] = useState(false);

  const query = useApiQuery(
    `knowledge:${tag}:${language}:${format}:${offlineOnly}`,
    () =>
      listKnowledgeResources({
        tag: tag.trim() || undefined,
        language: language || undefined,
        format: format || undefined,
        offlineAvailable: offlineOnly || undefined,
        pageSize: 60
      }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">Filter resources</legend>
        <Field id="kn-tag" label="Tag">
          <TextInput
            id="kn-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="e.g. maize"
          />
        </Field>
        <Field id="kn-lang" label="Language">
          <Select
            id="kn-lang"
            value={language}
            onChange={(e) => setLanguage(e.target.value as '' | LanguageCode)}
          >
            <option value="">All languages</option>
            {LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="kn-format" label="Format">
          <Select
            id="kn-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as '' | KnowledgeFormat)}
          >
            <option value="">All formats</option>
            {KNOWLEDGE_FORMATS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </Field>
        <CheckRow
          id="kn-offline"
          checked={offlineOnly}
          onChange={setOfflineOnly}
          label="Offline-ready only"
          description="Resources flagged for offline packs."
        />
      </fieldset>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title="No resources match" hint="Try clearing a filter." />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((resource) => (
            <ResourceCard key={resource.id} resource={resource} />
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* ------------------------------- podcasts ------------------------------- */

function EpisodeDetail({ episode }: { episode: PodcastEpisode }) {
  return (
    <article className="stack" style={{ marginTop: '0.5rem' }} aria-label={`Episode: ${episode.title}`}>
      <p className="small muted">{episode.showNotes}</p>
      {/* preload="none" keeps low-data connections from fetching audio early;
          the full transcript below is the accessibility equivalent. */}
      <audio controls preload="none" src={episode.audioUrl} style={{ width: '100%' }}>
        Your browser does not support audio playback — read the transcript below.
      </audio>
      <section aria-label="Transcript">
        <h4>Transcript</h4>
        {episode.transcript ? (
          <p>{episode.transcript}</p>
        ) : (
          <p className="small muted">Transcript is being prepared for this episode.</p>
        )}
      </section>
    </article>
  );
}

export function PodcastList() {
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useApiQuery(
    'podcast-episodes',
    () => listPodcastEpisodes().then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title="No podcast episodes yet" />}
      >
        <div className="stack">
          {(query.data ?? []).map((episode) => (
            <Card key={episode.id} title={episode.title}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <span className="small muted">
                  {formatDuration(episode.durationSeconds)} ·{' '}
                  {new Date(episode.publishedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                </span>
                <span className="cluster">
                  {episode.transcript ? <StatusBadge tone="success">transcript</StatusBadge> : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setOpenId(openId === episode.id ? null : episode.id)}
                    aria-expanded={openId === episode.id}
                  >
                    {openId === episode.id ? 'Close' : 'Listen / read'}
                  </button>
                </span>
              </div>
              {openId === episode.id ? <EpisodeDetail episode={episode} /> : null}
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* ------------------------------- webinars ------------------------------- */

function WebinarCard({ webinar }: { webinar: Webinar }) {
  const { userId } = useAppState();
  const [registered, setRegistered] = useState(false);
  // Fixed at mount — a webinar crossing its start time mid-session only
  // flips to "past" on the next render pass, which is acceptable.
  const [now] = useState(() => Date.now());

  const mutation = useApiMutation<void, unknown>({
    mutationFn: () => registerForWebinar(webinar.id, userId).then((res) => res.data),
    queue: {
      kind: 'knowledge.webinar.registered',
      label: () => `Webinar: ${webinar.title}`,
      method: 'POST',
      path: () => `/webinars/${webinar.id}/registrations`,
      payload: () => ({ userId })
    },
    onSuccess: () => setRegistered(true),
    onQueued: () => setRegistered(true)
  });

  const startsAt = new Date(webinar.startsAt);
  const past = webinar.status === 'completed' || startsAt.getTime() < now;

  return (
    <Card title={webinar.title}>
      <p className="small muted">
        {startsAt.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
        {webinar.timezone}
      </p>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <AutoBadge value={webinar.status} />
        {past && webinar.recordingUrl ? (
          <a className="btn btn-ghost btn-small" href={webinar.recordingUrl}>
            Watch recording
          </a>
        ) : registered ? (
          <StatusBadge tone="success">registered</StatusBadge>
        ) : !past && webinar.status !== 'cancelled' ? (
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={mutation.status === 'pending'}
            onClick={() => void mutation.mutate()}
          >
            {mutation.status === 'pending' ? 'Registering…' : 'Register'}
          </button>
        ) : null}
      </div>
      {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}
    </Card>
  );
}

export function WebinarList() {
  const query = useApiQuery('webinars', () => listWebinars().then((res) => res.data), {
    fallbackData: []
  });

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title="No webinars scheduled" hint="Recordings appear here after live sessions." />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((webinar) => (
            <WebinarCard key={webinar.id} webinar={webinar} />
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* --------------------------- my registrations --------------------------- */

/**
 * The signed-in member's webinar registrations (GET /webinars/mine/registrations)
 * joined with the webinar catalogue for titles, dates and recording links.
 * Registrations carry no join URL field on the API, so upcoming sessions show
 * a note instead of a dead link; past sessions link the recording.
 */
export function MyWebinarRegistrations() {
  const { hydrated } = useAppState();
  // Fixed at mount — sessions crossing their start time mid-render flip on
  // the next render pass, matching WebinarCard's convention.
  const [now] = useState(() => Date.now());
  const registrationsQuery = useApiQuery(
    hydrated ? 'webinars:mine' : null,
    () => listMyWebinarRegistrations().then((res) => res.data),
    { enabled: hydrated }
  );
  const webinarsQuery = useApiQuery(
    'webinars',
    () => listWebinars().then((res) => res.data),
    { fallbackData: [] }
  );

  const webinarsById = new Map((webinarsQuery.data ?? []).map((webinar) => [webinar.id, webinar]));
  const registrations = registrationsQuery.data ?? [];

  return (
    <>
      <QueryState
        isLoading={registrationsQuery.isLoading}
        error={registrationsQuery.error}
        data={registrations}
        onRetry={registrationsQuery.refresh}
        empty={
          <EmptyState
            title="No registrations yet"
            hint="Register for an upcoming webinar above and it appears here."
          />
        }
      >
        <ul className="row-list">
          {registrations.map((registration) => {
            const webinar = webinarsById.get(registration.webinarId);
            const startsAt = webinar ? new Date(webinar.startsAt) : null;
            const past =
              webinar !== undefined &&
              (webinar.status === 'completed' || (startsAt !== null && startsAt.getTime() < now));
            return (
              <li className="row-item" key={registration.id}>
                <div className="row-main">
                  <div className="row-title">{webinar?.title ?? registration.webinarId}</div>
                  <div className="small muted">
                    {startsAt
                      ? startsAt.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
                      : 'Schedule unavailable'}
                    {' · '}registered{' '}
                    {new Date(registration.registeredAt).toLocaleDateString('en-NG', {
                      dateStyle: 'medium'
                    })}
                  </div>
                </div>
                <span className="cluster">
                  {webinar ? <AutoBadge value={webinar.status} /> : null}
                  {past && webinar?.recordingUrl ? (
                    <a className="btn btn-ghost btn-small" href={webinar.recordingUrl}>
                      Watch recording
                    </a>
                  ) : !past ? (
                    <span className="small muted">Join details are shared before the session</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </QueryState>
    </>
  );
}
