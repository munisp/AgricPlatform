'use client';

import { useState } from 'react';
import { NIGERIAN_STATES, VALUE_CHAINS } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { createTopic, listMentorRequests, listTopics, requestMentor } from '@/lib/api/endpoints';
import { demoMentorRequests, demoTopics } from '@/lib/content';
import { Field, Select, TextArea, TextInput } from '@/components/forms';
import { AutoBadge, Card, StatusBadge } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/community/topics and
// GET /api/v1/community/mentors/requests.
const FALLBACK_TOPICS = demoTopics;
const FALLBACK_MENTORS = demoMentorRequests;

export function TopicsSection() {
  const query = useApiQuery(
    'community:topics',
    () => listTopics({ pageSize: 30 }).then((res) => res.data),
    { fallbackData: FALLBACK_TOPICS }
  );

  return (
    <div className="stack-lg">
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <ul className="row-list">
          {(query.data ?? []).map((topic) => (
            <li className="row-item" key={topic.id}>
              <div className="row-main">
                <div className="row-title">{topic.title}</div>
                <div className="small muted">
                  {topic.category}
                  {topic.state ? ` · ${topic.state}` : ''}
                  {topic.crop ? ` · ${topic.crop}` : ''} ·{' '}
                  {new Date(topic.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                </div>
              </div>
              <StatusBadge tone="neutral">{topic.replyCount} replies</StatusBadge>
            </li>
          ))}
        </ul>
      </QueryState>
      <TopicForm onCreated={() => query.refresh()} />
    </div>
  );
}

function TopicForm({ onCreated }: { onCreated: () => void }) {
  const { userId } = useAppState();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Markets');
  const [state, setState] = useState('');
  const [crop, setCrop] = useState('');

  const mutation = useApiMutation<void, unknown>({
    mutationFn: () =>
      createTopic({
        title: title.trim(),
        category,
        authorId: userId,
        state: state || undefined,
        crop: crop || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'community.topic.created',
      label: () => `Topic: ${title.trim()}`,
      method: 'POST',
      path: () => '/community/topics',
      payload: () => ({
        title: title.trim(),
        category,
        authorId: userId,
        state: state || undefined,
        crop: crop || undefined
      })
    },
    onSuccess: onCreated,
    onQueued: onCreated
  });

  const valid = title.trim().length >= 8;

  return (
    <div className="card">
      <h3>Start a topic</h3>
      <div className="form-grid cols-2">
        <Field id="tf-title" label="Title" hint="At least 8 characters.">
          <TextInput
            id="tf-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Best maize spacing for Zaria soils?"
          />
        </Field>
        <Field id="tf-category" label="Category">
          <Select id="tf-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {['Markets', 'Pest & Disease', 'Livestock', 'Student & NYSC', 'Equipment', 'Weather'].map(
              (option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              )
            )}
          </Select>
        </Field>
        <Field id="tf-state" label="State (optional)">
          <Select id="tf-state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {NIGERIAN_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="tf-crop" label="Crop (optional)">
          <Select id="tf-crop" value={crop} onChange={(e) => setCrop(e.target.value)}>
            <option value="">Not crop-specific</option>
            {VALUE_CHAINS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
        {mutation.status === 'success' ? <StatusBadge tone="success">topic posted</StatusBadge> : null}
        {mutation.status === 'queued' ? <StatusBadge tone="warning">topic queued</StatusBadge> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || mutation.status === 'pending'}
          onClick={() => void mutation.mutate()}
        >
          {mutation.status === 'pending' ? 'Posting…' : 'Post topic'}
        </button>
      </div>
      {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}
    </div>
  );
}

export function MentorBoard() {
  const { userId, hydrated } = useAppState();
  const [crop, setCrop] = useState('');
  const [state, setState] = useState('');
  const [challenge, setChallenge] = useState('');

  const query = useApiQuery(
    hydrated ? `community:mentors:${userId}` : null,
    () => listMentorRequests({}).then((res) => res.data),
    { fallbackData: FALLBACK_MENTORS, enabled: hydrated }
  );

  const mutation = useApiMutation<void, unknown>({
    mutationFn: () =>
      requestMentor({ userId, crop, state, challenge: challenge.trim() }).then((res) => res.data),
    queue: {
      kind: 'community.mentor.requested',
      label: () => `Mentor request: ${crop} — ${state}`,
      method: 'POST',
      path: () => '/community/mentors/requests',
      payload: () => ({ userId, crop, state, challenge: challenge.trim() })
    },
    onSuccess: () => query.refresh(),
    onQueued: () => query.refresh()
  });

  const valid = crop !== '' && state !== '' && challenge.trim().length >= 12;

  return (
    <div className="stack-lg">
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <div className="grid grid-2">
          {(query.data ?? []).map((request) => (
            <Card key={request.id} title={`${request.crop} — ${request.state}`}>
              <p className="small muted">{request.challenge}</p>
              <AutoBadge value={request.status} />
            </Card>
          ))}
        </div>
      </QueryState>

      <div className="card">
        <h3>Request a mentor</h3>
        <div className="form-grid cols-2">
          <Field id="mr-crop" label="Crop / value chain">
            <Select id="mr-crop" value={crop} onChange={(e) => setCrop(e.target.value)}>
              <option value="">Select…</option>
              {VALUE_CHAINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="mr-state" label="State">
            <Select id="mr-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Select…</option>
              {NIGERIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field id="mr-challenge" label="Your challenge" hint="At least 12 characters.">
          <TextArea
            id="mr-challenge"
            value={challenge}
            onChange={(e) => setChallenge(e.target.value)}
            placeholder="Describe what you are trying to achieve and where you are stuck."
          />
        </Field>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          {mutation.status === 'success' ? <StatusBadge tone="success">request sent</StatusBadge> : null}
          {mutation.status === 'queued' ? <StatusBadge tone="warning">request queued</StatusBadge> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || mutation.status === 'pending'}
            onClick={() => void mutation.mutate()}
          >
            {mutation.status === 'pending' ? 'Sending…' : 'Request mentor'}
          </button>
        </div>
        {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}
      </div>
    </div>
  );
}
