'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PROGRAMME_TYPES } from '@agric-platform/shared';
import type {
  CohortThread,
  MilestoneProgressStatus,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeType
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  createCohortThread,
  createThreadPost,
  enrolInCohort,
  fetchCohortLeaderboard,
  fetchCohortProgress,
  fetchProgrammeCohort,
  listCohortMilestones,
  listCohortThreads,
  listProgrammeCohorts,
  listThreadPosts,
  setMilestoneProgress,
  withdrawFromCohort
} from '@/lib/api/endpoints';
import { ForbiddenError } from '@/lib/api/errors';
import { usePersistentState } from '@/lib/use-persistent-state';
import { Field, Select, TextArea, TextInput } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';
import { AutoBadge, Card, EmptyState, ProgressBar, StatusBadge } from '@/components/ui';

/** Enrolments recorded on this device: cohortId → enrolment. */
const MY_ENROLMENTS_KEY = 'agric.my-cohort-enrolments';

type EnrolmentMap = Record<string, ProgrammeEnrolment>;

/* ------------------------------ directory ------------------------------ */

export function CohortDirectory() {
  const [type, setType] = useState<'' | ProgrammeType>('');

  const query = useApiQuery(
    `programme-cohorts:${type}`,
    () =>
      listProgrammeCohorts({ programmeType: type || undefined, pageSize: 60 }).then(
        (res) => res.data
      ),
    { fallbackData: [] }
  );

  return (
    <>
      <fieldset className="filters">
        <legend className="sr-only">Filter cohorts</legend>
        <Field id="pg-type" label="Programme">
          <Select
            id="pg-type"
            value={type}
            onChange={(e) => setType(e.target.value as '' | ProgrammeType)}
          >
            <option value="">All programmes</option>
            {PROGRAMME_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {entry === 'women' ? 'Women in agribusiness' : 'Youth (18–35)'}
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
        empty={<EmptyState title="No cohorts open right now" hint="Check back soon — cohorts open in waves." />}
      >
        <div className="grid grid-3">
          {(query.data ?? []).map((cohort) => (
            <Card key={cohort.id} title={cohort.name}>
              <p className="small muted">
                {cohort.programmeType === 'women' ? 'Women in agribusiness' : 'Youth programme'} ·
                capacity {cohort.capacity.toLocaleString('en-NG')} · enrolment closes{' '}
                {new Date(cohort.enrolmentClosesAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <AutoBadge value={cohort.status} />
                <Link className="btn btn-ghost btn-small" href={`/programmes/${cohort.id}`}>
                  View cohort
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* ------------------------------- threads ------------------------------- */

function ThreadPanel({ cohortId, enrolled }: { cohortId: string; enrolled: boolean }) {
  const { userId, hydrated } = useAppState();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [reply, setReply] = useState('');

  const threadsQuery = useApiQuery(
    hydrated && enrolled ? `cohort-threads:${cohortId}` : null,
    () => listCohortThreads(cohortId).then((res) => res.data),
    { enabled: hydrated && enrolled }
  );

  const postsQuery = useApiQuery(
    selectedThreadId ? `thread-posts:${selectedThreadId}` : null,
    () => listThreadPosts(selectedThreadId!).then((res) => res.data),
    { enabled: selectedThreadId !== null }
  );

  const threadMutation = useApiMutation<{ title: string }, CohortThread>({
    mutationFn: ({ title }) =>
      createCohortThread(cohortId, { title, authorId: userId }).then((res) => res.data),
    onSuccess: () => {
      setNewTitle('');
      threadsQuery.refresh();
    }
  });

  const postMutation = useApiMutation<{ body: string }, unknown>({
    mutationFn: ({ body }) =>
      createThreadPost(selectedThreadId!, { authorId: userId, body }).then((res) => res.data),
    onSuccess: () => {
      setReply('');
      postsQuery.refresh();
      threadsQuery.refresh();
    }
  });

  if (!enrolled) {
    return (
      <p className="notice notice-info">
        Protected space — threads are only visible to enrolled members and moderators.
      </p>
    );
  }

  if (threadsQuery.error instanceof ForbiddenError) {
    return (
      <p className="notice notice-info" role="status">
        Protected space — your enrolment could not be verified for these threads.
      </p>
    );
  }

  const threads = threadsQuery.data ?? [];
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  return (
    <div className="stack">
      <QueryState
        isLoading={threadsQuery.isLoading}
        error={threadsQuery.error}
        data={threads}
        onRetry={threadsQuery.refresh}
        empty={<p className="small muted">No threads yet — start the first one below.</p>}
      >
        <ul className="row-list">
          {threads.map((thread) => (
            <li className="row-item" key={thread.id}>
              <div className="row-main">
                <div className="row-title">{thread.title}</div>
                <div className="small muted">{thread.replyCount} replies</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => setSelectedThreadId(thread.id === selectedThreadId ? null : thread.id)}
                aria-expanded={selectedThreadId === thread.id}
              >
                {selectedThreadId === thread.id ? 'Close' : 'Open'}
              </button>
            </li>
          ))}
        </ul>
      </QueryState>

      {selectedThread ? (
        <Card title={`Replies — ${selectedThread.title}`}>
          <QueryState
            isLoading={postsQuery.isLoading}
            error={postsQuery.error}
            data={postsQuery.data}
            onRetry={postsQuery.refresh}
            empty={<p className="small muted">No replies yet.</p>}
          >
            <ul className="row-list">
              {(postsQuery.data ?? []).map((post) => (
                <li className="row-item" key={post.id}>
                  <div className="row-main">
                    <div>{post.body}</div>
                    <div className="small muted">
                      {new Date(post.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </QueryState>
          <Field id={`reply-${selectedThread.id}`} label="Your reply">
            <TextArea
              id={`reply-${selectedThread.id}`}
              value={reply}
              rows={2}
              onChange={(e) => setReply(e.target.value)}
            />
          </Field>
          <div className="cluster" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={reply.trim().length < 2 || postMutation.status === 'pending'}
              onClick={() => void postMutation.mutate({ body: reply.trim() })}
            >
              {postMutation.status === 'pending' ? 'Posting…' : 'Post reply'}
            </button>
          </div>
          {postMutation.status === 'error' ? <ApiErrorNotice error={postMutation.error} /> : null}
        </Card>
      ) : null}

      <div className="cluster">
        <Field id={`new-thread-${cohortId}`} label="New thread title">
          <TextInput
            id={`new-thread-${cohortId}`}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="e.g. Irrigation questions for week 3"
          />
        </Field>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={newTitle.trim().length < 4 || threadMutation.status === 'pending'}
          onClick={() => void threadMutation.mutate({ title: newTitle.trim() })}
        >
          {threadMutation.status === 'pending' ? 'Creating…' : 'Create thread'}
        </button>
      </div>
      {threadMutation.status === 'error' ? <ApiErrorNotice error={threadMutation.error} /> : null}
    </div>
  );
}

/* -------------------------------- detail ------------------------------- */

export function CohortDetail({ cohortId }: { cohortId: string }) {
  const { userId, hydrated } = useAppState();
  const [enrolments, setEnrolments] = usePersistentState<EnrolmentMap>(MY_ENROLMENTS_KEY, {});
  const [declaredAge, setDeclaredAge] = useState('');
  const [declaredGender, setDeclaredGender] = useState<'' | 'female' | 'male' | 'other'>('');

  const myEnrolment = enrolments[cohortId];
  const enrolled = Boolean(myEnrolment && myEnrolment.status === 'enrolled');

  const cohortQuery = useApiQuery(
    `programme-cohort:${cohortId}`,
    () => fetchProgrammeCohort(cohortId).then((res) => res.data)
  );
  const milestonesQuery = useApiQuery(
    `cohort-milestones:${cohortId}`,
    () => listCohortMilestones(cohortId).then((res) => res.data),
    { fallbackData: [] }
  );
  const progressQuery = useApiQuery(
    hydrated && enrolled ? `cohort-progress:${cohortId}:${userId}` : null,
    () => fetchCohortProgress(cohortId, userId).then((res) => res.data),
    { fallbackData: [], enabled: hydrated && enrolled }
  );
  const leaderboardQuery = useApiQuery(
    `cohort-leaderboard:${cohortId}`,
    () => fetchCohortLeaderboard(cohortId).then((res) => res.data),
    { fallbackData: [] }
  );

  const enrolMutation = useApiMutation<
    { declaredAge?: number; declaredGender?: 'female' | 'male' | 'other' },
    ProgrammeEnrolment
  >({
    mutationFn: (input) =>
      enrolInCohort(cohortId, { userId, ...input }).then((res) => res.data),
    queue: {
      kind: 'programmes.enrolment.created',
      label: () => 'Cohort enrolment',
      method: 'POST',
      path: () => `/programme-cohorts/${cohortId}/enrolments`,
      payload: (input) => ({ userId, ...input })
    },
    onSuccess: (enrolment) =>
      setEnrolments((current) => ({ ...current, [cohortId]: enrolment }))
  });

  const withdrawMutation = useApiMutation<void, ProgrammeEnrolment>({
    mutationFn: () => withdrawFromCohort(cohortId, userId).then((res) => res.data),
    onSuccess: (enrolment) =>
      setEnrolments((current) => ({ ...current, [cohortId]: enrolment }))
  });

  const progressMutation = useApiMutation<
    { milestoneId: string; status: MilestoneProgressStatus },
    unknown
  >({
    mutationFn: ({ milestoneId, status }) =>
      setMilestoneProgress(milestoneId, { userId, status }).then((res) => res.data),
    queue: {
      kind: 'programmes.milestone.progress',
      label: () => 'Milestone progress',
      method: 'POST',
      path: ({ milestoneId }) => `/programme-milestones/${milestoneId}/progress`,
      payload: ({ status }) => ({ userId, status })
    },
    onSuccess: () => progressQuery.refresh(),
    onQueued: () => progressQuery.refresh()
  });

  const cohort = cohortQuery.data;
  const milestones = milestonesQuery.data ?? [];
  const progress = progressQuery.data ?? [];
  const progressByMilestone = new Map(progress.map((entry) => [entry.milestoneId, entry]));
  const completedCount = progress.filter((entry) => entry.status === 'completed').length;
  const completionPercent =
    milestones.length > 0 ? Math.round((completedCount / milestones.length) * 100) : 0;

  return (
    <>
      <QueryState
        isLoading={cohortQuery.isLoading}
        error={cohortQuery.error}
        data={cohort}
        onRetry={cohortQuery.refresh}
      >
        {cohort ? (
          <Card title={cohort.name}>
            <p className="small muted">
              {cohort.programmeType === 'women' ? 'Women in agribusiness' : 'Youth programme'} ·
              capacity {cohort.capacity.toLocaleString('en-NG')} · enrolment{' '}
              {new Date(cohort.enrolmentOpensAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              {' → '}
              {new Date(cohort.enrolmentClosesAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
            </p>
            <div className="cluster">
              <AutoBadge value={cohort.status} />
              {enrolled ? <StatusBadge tone="success">enrolled</StatusBadge> : null}
            </div>
          </Card>
        ) : null}
      </QueryState>

      <div className="card">
        <h3>{enrolled ? 'Your enrolment' : 'Enrol in this cohort'}</h3>
        {enrolled ? (
          <div className="cluster">
            <p className="small muted" style={{ margin: 0 }}>
              Enrolled{' '}
              {new Date(myEnrolment!.enrolledAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}.
            </p>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={withdrawMutation.status === 'pending'}
              onClick={() => void withdrawMutation.mutate()}
            >
              {withdrawMutation.status === 'pending' ? 'Withdrawing…' : 'Withdraw'}
            </button>
          </div>
        ) : (
          <>
            <p className="small muted">
              Only self-declared attributes are stored — no document uploads.
            </p>
            <div className="form-grid cols-2">
              <Field id="pg-age" label="Your age (optional)">
                <TextInput
                  id="pg-age"
                  value={declaredAge}
                  inputMode="numeric"
                  onChange={(e) => setDeclaredAge(e.target.value.replace(/[^0-9]/g, ''))}
                />
              </Field>
              <Field id="pg-gender" label="Gender (optional)">
                <Select
                  id="pg-gender"
                  value={declaredGender}
                  onChange={(e) => setDeclaredGender(e.target.value as '' | 'female' | 'male' | 'other')}
                >
                  <option value="">Prefer not to say</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
            </div>
            <div className="cluster" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={enrolMutation.status === 'pending' || cohort?.status !== 'open'}
                title={cohort && cohort.status !== 'open' ? 'Enrolment is not open for this cohort' : undefined}
                onClick={() =>
                  void enrolMutation.mutate({
                    declaredAge: declaredAge ? Number(declaredAge) : undefined,
                    declaredGender: declaredGender || undefined
                  })
                }
              >
                {enrolMutation.status === 'pending' ? 'Enrolling…' : 'Enrol'}
              </button>
            </div>
            {enrolMutation.status === 'queued' ? (
              <StatusBadge tone="warning">enrolment queued for sync</StatusBadge>
            ) : null}
          </>
        )}
        {enrolMutation.status === 'error' ? <ApiErrorNotice error={enrolMutation.error} /> : null}
        {withdrawMutation.status === 'error' ? <ApiErrorNotice error={withdrawMutation.error} /> : null}
      </div>

      <h3>Milestones{enrolled ? ' and your progress' : ''}</h3>
      {enrolled ? <ProgressBar value={completionPercent} label="Completion" /> : null}
      <QueryState
        isLoading={milestonesQuery.isLoading}
        error={milestonesQuery.error}
        data={milestones}
        onRetry={milestonesQuery.refresh}
        empty={<EmptyState title="No milestones published yet" />}
      >
        <ul className="row-list">
          {milestones.map((milestone) => {
            const entry = progressByMilestone.get(milestone.id);
            return (
              <li className="row-item" key={milestone.id}>
                <div className="row-main">
                  <div className="row-title">
                    {milestone.sequence}. {milestone.title}
                  </div>
                  {milestone.dueAt ? (
                    <div className="small muted">
                      Due {new Date(milestone.dueAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                    </div>
                  ) : null}
                </div>
                {enrolled ? (
                  entry?.status === 'completed' ? (
                    <StatusBadge tone="success">completed</StatusBadge>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={progressMutation.status === 'pending'}
                      onClick={() =>
                        void progressMutation.mutate({
                          milestoneId: milestone.id,
                          status: entry?.status === 'in_progress' ? 'completed' : 'in_progress'
                        })
                      }
                    >
                      {entry?.status === 'in_progress' ? 'Mark complete' : 'Start'}
                    </button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      </QueryState>
      {progressMutation.status === 'error' ? <ApiErrorNotice error={progressMutation.error} /> : null}

      <h3>Leaderboard</h3>
      <QueryState
        isLoading={leaderboardQuery.isLoading}
        error={leaderboardQuery.error}
        data={leaderboardQuery.data}
        onRetry={leaderboardQuery.refresh}
        empty={<EmptyState title="No judging scores yet" hint="The leaderboard fills in once judges submit scores." />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Entry</th>
                <th>Total score</th>
                <th>Judges</th>
                <th>Average</th>
              </tr>
            </thead>
            <tbody>
              {(leaderboardQuery.data ?? []).map((row) => (
                <tr key={row.entryUserId}>
                  <td>{row.rank}</td>
                  <td>{row.entryUserId}</td>
                  <td>{row.totalScore}</td>
                  <td>{row.judgeCount}</td>
                  <td>{row.averageScore.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      <h3>Protected threads</h3>
      <ThreadPanel cohortId={cohortId} enrolled={enrolled} />
    </>
  );
}
