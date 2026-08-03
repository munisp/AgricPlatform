'use client';

import { useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  captureFarmerProfile,
  listMyAgentAssignments,
  reportAgentAssignmentProgress,
  type AgentAssignment,
  type CaptureFarmerProfileResult
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { ApiErrorNotice, QueryState } from '@/components/api-state';
import { Field, TextArea, TextInput } from '@/components/forms';
import { EmptyState, ProgressBar } from '@/components/ui';

/**
 * Wave AGENTS enumerator view: the caller's open assignment queue with a
 * progress action per card, plus the on-behalf farmer-profile capture form
 * (records a 'field-data-capture' consent server-side). Progress reports are
 * queueable mutations — offline they park in the sync queue and replay.
 */
export function AgentQueue() {
  const { t } = useT();
  const { hydrated } = useAppState();

  const queue = useApiQuery(
    hydrated ? 'field-agents:mine' : null,
    () => listMyAgentAssignments().then((res) => res.data),
    { enabled: hydrated }
  );

  const progressMutation = useApiMutation<string, AgentAssignment>({
    mutationFn: (id) => reportAgentAssignmentProgress(id).then((res) => res.data),
    queue: {
      kind: 'field-agents.assignment.progress',
      label: (id) => `Report progress on ${id}`,
      method: 'POST',
      path: (id) => `/field-agents/assignments/${encodeURIComponent(id)}/progress`,
      payload: () => ({ count: 1 })
    },
    onSuccess: () => queue.refresh(),
    onQueued: () => queue.refresh()
  });

  return (
    <div className="stack">
      <section aria-labelledby="agent-queue">
        <h2 id="agent-queue">{t('agents.queueTitle')}</h2>
        <QueryState
          isLoading={queue.isLoading}
          error={queue.error}
          data={queue.data}
          onRetry={queue.refresh}
          empty={<EmptyState title={t('agents.queueEmpty')} />}
        >
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {(queue.data ?? []).map((assignment) => (
              <li key={assignment.id} className="card">
                <strong>{assignment.purpose}</strong>
                <p className="small soft">
                  {assignment.state} / {assignment.lga}
                  {assignment.ward ? ` / ${assignment.ward}` : ''}
                  {assignment.dueAt ? ` · due ${assignment.dueAt.slice(0, 10)}` : ''}
                </p>
                <ProgressBar
                  value={
                    assignment.targetCount > 0
                      ? (assignment.completedCount / assignment.targetCount) * 100
                      : 0
                  }
                  label={t('agents.progressLabel', {
                    completed: assignment.completedCount,
                    target: assignment.targetCount
                  })}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={progressMutation.status === 'pending'}
                  onClick={() => void progressMutation.mutate(assignment.id)}
                >
                  {progressMutation.status === 'pending'
                    ? t('agents.reporting')
                    : t('agents.reportProgress')}
                </button>
              </li>
            ))}
          </ul>
        </QueryState>
        {progressMutation.status === 'error' ? (
          <ApiErrorNotice error={progressMutation.error} />
        ) : null}
      </section>

      <CaptureForm />
    </div>
  );
}

function CaptureForm() {
  const { t } = useT();
  const [farmerRef, setFarmerRef] = useState('');
  const [state, setState] = useState('');
  const [lga, setLga] = useState('');
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState('');
  const [done, setDone] = useState<CaptureFarmerProfileResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const captureMutation = useApiMutation<void, CaptureFarmerProfileResult>({
    mutationFn: async () => {
      const ref = farmerRef.trim();
      if (!ref) {
        throw new Error('Farmer phone or user id is required');
      }
      const input = {
        // A leading '+' or digit run means a phone number; otherwise a user id.
        ...(ref.startsWith('+') || /^\d+$/.test(ref)
          ? { farmerPhone: ref }
          : { farmerUserId: ref }),
        ...(state.trim() && lga.trim()
          ? { location: { state: state.trim(), lga: lga.trim() } }
          : {}),
        ...(bio.trim() ? { bio: bio.trim() } : {}),
        ...(interests.trim()
          ? {
              farmingInterests: interests
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            }
          : {})
      };
      const res = await captureFarmerProfile(input);
      return res.data;
    },
    onSuccess: (result) => {
      setDone(result);
      setFormError(null);
    }
  });

  async function submit() {
    setDone(null);
    setFormError(null);
    const result = await captureMutation.mutate();
    if (result === undefined && captureMutation.status === 'error') {
      setFormError('Could not save the farmer profile — check the details and try again.');
    }
  }

  return (
    <section aria-labelledby="agent-capture">
      <h2 id="agent-capture">{t('agents.captureTitle')}</h2>
      <p className="small soft">{t('agents.captureDescription')}</p>
      <div className="grid-2">
        <Field id="capture-farmer" label={t('agents.farmerPhone')}>
          <TextInput
            id="capture-farmer"
            value={farmerRef}
            onChange={(event) => setFarmerRef(event.target.value)}
            placeholder="+2348012345678"
          />
        </Field>
        <Field id="capture-interests" label={t('onboarding.interests')}>
          <TextInput
            id="capture-interests"
            value={interests}
            onChange={(event) => setInterests(event.target.value)}
            placeholder="Maize, Cassava"
          />
        </Field>
        <Field id="capture-state" label={t('agents.state')}>
          <TextInput
            id="capture-state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          />
        </Field>
        <Field id="capture-lga" label={t('agents.lga')}>
          <TextInput
            id="capture-lga"
            value={lga}
            onChange={(event) => setLga(event.target.value)}
          />
        </Field>
      </div>
      <Field id="capture-bio" label={t('agents.bio')}>
        <TextArea
          id="capture-bio"
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          rows={3}
        />
      </Field>
      {formError ? <p role="alert">{formError}</p> : null}
      {done ? <p role="status">{t('agents.captureDone', { consentId: done.consentId })}</p> : null}
      <button
        type="button"
        className="btn btn-primary"
        disabled={captureMutation.status === 'pending'}
        onClick={() => void submit()}
      >
        {captureMutation.status === 'pending' ? t('agents.capturing') : t('agents.capture')}
      </button>
    </section>
  );
}
