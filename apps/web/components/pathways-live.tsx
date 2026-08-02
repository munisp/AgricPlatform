'use client';

import { useState } from 'react';
import { NIGERIAN_STATES, PATHWAY_TRACKS } from '@agric-platform/shared';
import type {
  CampusClub,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  PathwayTrack
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  completePathwayStage,
  enrolInPathway,
  fetchPathwayEnrolment,
  fetchPathwayTemplate,
  joinCampusClub,
  listCampusClubs,
  listPathwayTemplates
} from '@/lib/api/endpoints';
import { usePersistentState } from '@/lib/use-persistent-state';
import { Field, Select, TextArea } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, StatusBadge } from '@/components/ui';

/** Pathway enrolments recorded on this device: enrolmentId → template name. */
const MY_PATHWAYS_KEY = 'agric.my-pathway-enrolments';

function trackLabel(track: PathwayTrack): string {
  return track === 'student' ? 'Student' : 'NYSC';
}

/* --------------------------- template browser --------------------------- */

function TemplateDetail({ template }: { template: PathwayTemplate }) {
  const { userId } = useAppState();
  const [myPathways, setMyPathways] =
    usePersistentState<Record<string, string>>(MY_PATHWAYS_KEY, {});
  const [justEnrolled, setJustEnrolled] = useState(false);

  const detailQuery = useApiQuery(
    `pathway-template:${template.id}`,
    () => fetchPathwayTemplate(template.id).then((res) => res.data),
    { fallbackData: { template, stages: [] as PathwayStage[] } }
  );

  const enrolMutation = useApiMutation<void, PathwayEnrolment>({
    mutationFn: () => enrolInPathway(template.id, userId).then((res) => res.data),
    queue: {
      kind: 'pathways.enrolment.created',
      label: () => `Pathway: ${template.name}`,
      method: 'POST',
      path: () => `/pathway-templates/${template.id}/enrol`,
      payload: () => ({ userId })
    },
    onSuccess: (enrolment) => {
      setMyPathways((current) => ({ ...current, [enrolment.id]: template.name }));
      setJustEnrolled(true);
    },
    onQueued: () => setJustEnrolled(true)
  });

  const stages = detailQuery.data?.stages ?? [];
  const alreadyEnrolled = justEnrolled || Object.values(myPathways).includes(template.name);

  return (
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      {template.description ? <p className="small muted">{template.description}</p> : null}
      <ol className="timeline">
        {stages.map((stage) => (
          <li className="timeline-item" key={stage.id}>
            <span className="timeline-dot" aria-hidden="true" />
            <div className="timeline-title">
              {stage.sequence}. {stage.title}
            </div>
            {stage.requiredActions.length > 0 ? (
              <p className="muted small">{stage.requiredActions.join(' · ')}</p>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        {alreadyEnrolled ? (
          <StatusBadge tone="success">enrolled — see your pathway below</StatusBadge>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={enrolMutation.status === 'pending'}
            onClick={() => void enrolMutation.mutate()}
          >
            {enrolMutation.status === 'pending' ? 'Enrolling…' : 'Enrol on this pathway'}
          </button>
        )}
      </div>
      {enrolMutation.status === 'error' ? <ApiErrorNotice error={enrolMutation.error} /> : null}
    </div>
  );
}

export function PathwayBrowser() {
  const [track, setTrack] = useState<'' | PathwayTrack>('');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useApiQuery(
    `pathway-templates:${track}`,
    () => listPathwayTemplates({ track: track || undefined }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">Filter pathways</legend>
        <Field id="pw-track" label="Track">
          <Select
            id="pw-track"
            value={track}
            onChange={(e) => setTrack(e.target.value as '' | PathwayTrack)}
          >
            <option value="">All tracks</option>
            {PATHWAY_TRACKS.map((entry) => (
              <option key={entry} value={entry}>
                {trackLabel(entry)}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title="No pathways on this track yet" />}
      >
        <div className="grid grid-2">
          {(query.data ?? []).map((template) => (
            <Card key={template.id} title={template.name}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <StatusBadge tone="info">{trackLabel(template.track)}</StatusBadge>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => setOpenId(openId === template.id ? null : template.id)}
                  aria-expanded={openId === template.id}
                >
                  {openId === template.id ? 'Hide stages' : 'View stages'}
                </button>
              </div>
              {openId === template.id ? <TemplateDetail template={template} /> : null}
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* ----------------------------- my pathways ------------------------------ */

function MyPathwayCard({ enrolmentId, templateName }: { enrolmentId: string; templateName: string }) {
  const [evidence, setEvidence] = useState('');

  const query = useApiQuery(
    `pathway-enrolment:${enrolmentId}`,
    () => fetchPathwayEnrolment(enrolmentId).then((res) => res.data)
  );
  const templateQuery = useApiQuery(
    query.data?.enrolment.templateId ? `pathway-template:${query.data.enrolment.templateId}` : null,
    () => fetchPathwayTemplate(query.data!.enrolment.templateId).then((res) => res.data),
    { enabled: Boolean(query.data?.enrolment.templateId) }
  );

  const completeMutation = useApiMutation<{ evidence: string }, PathwayEnrolment>({
    mutationFn: ({ evidence: text }) =>
      completePathwayStage(enrolmentId, text).then((res) => res.data),
    queue: {
      kind: 'pathways.stage.completed',
      label: () => `Stage evidence: ${templateName}`,
      method: 'POST',
      path: () => `/pathway-enrolments/${enrolmentId}/complete-stage`,
      payload: ({ evidence: text }) => ({ evidence: text })
    },
    onSuccess: () => {
      setEvidence('');
      query.refresh();
    },
    onQueued: () => setEvidence('')
  });

  if (query.error) {
    return <ApiErrorNotice error={query.error} onRetry={query.refresh} />;
  }
  const enrolment = query.data?.enrolment;
  if (!enrolment) {
    return <p className="small muted">Loading your pathway…</p>;
  }

  const stages = templateQuery.data?.stages ?? [];
  const progress = query.data?.progress ?? [];
  const completedStageIds = new Set(
    progress.filter((entry) => entry.status === 'completed').map((entry) => entry.stageId)
  );
  const currentStage = stages.find((stage) => stage.id === enrolment.currentStageId);

  return (
    <Card title={templateName}>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <AutoBadge value={enrolment.status} />
        <span className="small muted">
          {completedStageIds.size} of {stages.length} stages complete
        </span>
      </div>
      <ol className="timeline">
        {stages.map((stage) => {
          const done = completedStageIds.has(stage.id);
          const isCurrent = stage.id === enrolment.currentStageId;
          return (
            <li className="timeline-item" key={stage.id}>
              <span className={`timeline-dot${isCurrent && !done ? ' warning' : ''}`} aria-hidden="true" />
              <div className="timeline-title">
                {stage.sequence}. {stage.title}{' '}
                {done ? <StatusBadge tone="success">done</StatusBadge> : null}
                {isCurrent && !done ? <StatusBadge tone="warning">current</StatusBadge> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {enrolment.status === 'active' && currentStage ? (
        <div className="stack">
          <Field
            id={`evidence-${enrolmentId}`}
            label={`Evidence for "${currentStage.title}"`}
            hint="A link or short description of what you did. Required to complete the stage."
          >
            <TextArea
              id={`evidence-${enrolmentId}`}
              value={evidence}
              rows={2}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="e.g. Photo of my demo plot, or a link to my report"
            />
          </Field>
          <div className="cluster" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={evidence.trim().length < 4 || completeMutation.status === 'pending'}
              onClick={() => void completeMutation.mutate({ evidence: evidence.trim() })}
            >
              {completeMutation.status === 'pending' ? 'Submitting…' : 'Submit evidence'}
            </button>
          </div>
          {completeMutation.status === 'queued' ? (
            <StatusBadge tone="warning">evidence queued for sync</StatusBadge>
          ) : null}
          {completeMutation.status === 'error' ? (
            <ApiErrorNotice error={completeMutation.error} />
          ) : null}
        </div>
      ) : null}
      {enrolment.status === 'completed' ? (
        <StatusBadge tone="success">pathway completed</StatusBadge>
      ) : null}
    </Card>
  );
}

export function MyPathways() {
  const [myPathways] = usePersistentState<Record<string, string>>(MY_PATHWAYS_KEY, {});
  const entries = Object.entries(myPathways);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No pathway enrolments yet"
        hint="Enrol on a student or NYSC pathway above to track your stage progress here."
      />
    );
  }

  return (
    <div className="stack">
      {entries.map(([enrolmentId, templateName]) => (
        <MyPathwayCard key={enrolmentId} enrolmentId={enrolmentId} templateName={templateName} />
      ))}
    </div>
  );
}

/* ------------------------------ campus clubs ---------------------------- */

function ClubCard({ club }: { club: CampusClub }) {
  const { userId } = useAppState();
  const [open, setOpen] = useState(false);
  const [joined, setJoined] = useState(false);

  const joinMutation = useApiMutation<void, unknown>({
    mutationFn: () => joinCampusClub(club.id, userId).then((res) => res.data),
    queue: {
      kind: 'pathways.club.joined',
      label: () => `Club: ${club.name}`,
      method: 'POST',
      path: () => `/campus-clubs/${club.id}/members`,
      payload: () => ({ userId })
    },
    onSuccess: () => setJoined(true),
    onQueued: () => setJoined(true)
  });

  return (
    <Card title={club.name}>
      <p className="small muted">
        {club.institution} · {club.state} · {club.memberCount.toLocaleString('en-NG')} members
      </p>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        {club.isNyscCdsGroup ? <StatusBadge tone="info">NYSC CDS group</StatusBadge> : <span />}
        <span className="cluster">
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            {open ? 'Less' : 'Details'}
          </button>
          {joined ? (
            <StatusBadge tone="success">joined</StatusBadge>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={joinMutation.status === 'pending'}
              onClick={() => void joinMutation.mutate()}
            >
              {joinMutation.status === 'pending' ? 'Joining…' : 'Join club'}
            </button>
          )}
        </span>
      </div>
      {open ? (
        <p className="small muted" style={{ marginTop: '0.5rem' }}>
          Campus club at {club.institution} in {club.state} state, coordinated on the platform.
          {club.isNyscCdsGroup
            ? ' This club doubles as an NYSC Community Development Service group.'
            : ''}
        </p>
      ) : null}
      {joinMutation.status === 'error' ? <ApiErrorNotice error={joinMutation.error} /> : null}
    </Card>
  );
}

export function ClubDirectory() {
  const [state, setState] = useState('');

  const query = useApiQuery(
    `campus-clubs:${state}`,
    () => listCampusClubs({ state: state || undefined }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">Filter campus clubs</legend>
        <Field id="club-state" label="State">
          <Select id="club-state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {NIGERIAN_STATES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<EmptyState title="No campus clubs found" hint="Try another state." />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((club) => (
            <ClubCard key={club.id} club={club} />
          ))}
        </div>
      </QueryState>
    </>
  );
}
