'use client';

import { useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  cancelAgentAssignment,
  createAgentAssignment,
  fetchAgentProductivity,
  listAgentAssignments,
  type AgentAssignment
} from '@/lib/api/endpoints';
import { useT, type TranslationKey } from '@/lib/i18n';
import { useFormDraft } from '@/lib/drafts';
import { ApiErrorNotice, QueryState } from '@/components/api-state';
import { Field, TextInput } from '@/components/forms';
import { EmptyState, ProgressBar, StatusBadge, type Tone } from '@/components/ui';

const STATUS_TONES: Record<AgentAssignment['status'], Tone> = {
  assigned: 'warning',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'critical'
};

const STATUS_LABEL_KEYS: Record<AgentAssignment['status'], TranslationKey> = {
  assigned: 'agents.statusAssigned',
  in_progress: 'agents.statusInProgress',
  completed: 'agents.statusCompleted',
  cancelled: 'agents.statusCancelled'
};

function progressPercent(assignment: AgentAssignment): number {
  return assignment.targetCount > 0
    ? (assignment.completedCount / assignment.targetCount) * 100
    : 0;
}

/**
 * Wave AGENTS admin/chapter-lead console: create assignments, follow the
 * board with progress bars, cancel open work, and (admin only) review
 * per-enumerator completion rates. Chapter-lead scoping is enforced
 * server-side; the board simply renders what the API returns.
 */
interface AssignmentDraft {
  agentUserId: string;
  state: string;
  lga: string;
  purpose: string;
  targetCount: string;
  chapterId: string;
}

const EMPTY_ASSIGNMENT_DRAFT: AssignmentDraft = {
  agentUserId: '',
  state: '',
  lga: '',
  purpose: '',
  targetCount: '1',
  chapterId: ''
};

export function AgentsBoard() {
  const { t } = useT();
  const { hydrated, role } = useAppState();
  // Draft persistence: assignment forms survive reloads/offline drops.
  const { draft, setDraft, clearDraft } = useFormDraft<AssignmentDraft>(
    'agents.assignment.new',
    EMPTY_ASSIGNMENT_DRAFT,
    (value) =>
      value.agentUserId.trim() === '' &&
      value.state.trim() === '' &&
      value.lga.trim() === '' &&
      value.purpose.trim() === '' &&
      value.chapterId.trim() === ''
  );
  const [formError, setFormError] = useState<string | null>(null);
  const setField = (key: keyof AssignmentDraft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const board = useApiQuery(
    hydrated ? 'field-agents:assignments' : null,
    () => listAgentAssignments().then((res) => res.data),
    { enabled: hydrated }
  );

  // Productivity is admin-only server-side; chapter leads skip the fetch.
  const productivity = useApiQuery(
    hydrated && role === 'admin' ? 'field-agents:productivity' : null,
    () => fetchAgentProductivity().then((res) => res.data),
    { enabled: hydrated && role === 'admin' }
  );

  const createMutation = useApiMutation<void, AgentAssignment>({
    mutationFn: async () => {
      const target = Number.parseInt(draft.targetCount, 10);
      if (!draft.agentUserId.trim() || !draft.state.trim() || !draft.lga.trim() || !draft.purpose.trim()) {
        throw new Error(t('agents.errorRequired'));
      }
      if (!Number.isInteger(target) || target < 1) {
        throw new Error(t('agents.errorTarget'));
      }
      const res = await createAgentAssignment({
        agentUserId: draft.agentUserId.trim(),
        state: draft.state.trim(),
        lga: draft.lga.trim(),
        purpose: draft.purpose.trim(),
        targetCount: target,
        ...(draft.chapterId.trim() ? { chapterId: draft.chapterId.trim() } : {})
      });
      return res.data;
    },
    onSuccess: () => {
      clearDraft();
      setFormError(null);
      board.refresh();
      productivity.refresh();
    },
    onError: () => {
      setFormError(t('agents.errorCreate'));
    }
  });

  const cancelMutation = useApiMutation<string, AgentAssignment>({
    mutationFn: (id) => cancelAgentAssignment(id).then((res) => res.data),
    onSuccess: () => {
      board.refresh();
      productivity.refresh();
    }
  });

  async function submitCreate() {
    setFormError(null);
    // Errors surface via the mutation's onError callback (fresh state, no
    // stale-closure read of createMutation.status after the await).
    await createMutation.mutate();
  }

  return (
    <div className="stack">
      <section aria-labelledby="agents-create">
        <h2 id="agents-create">{t('agents.createTitle')}</h2>
        <div className="grid-2">
          <Field id="agent-user" label={t('agents.agentUserId')}>
            <TextInput
              id="agent-user"
              value={draft.agentUserId}
              onChange={(event) => setField('agentUserId', event.target.value)}
              placeholder="user-enumerator"
            />
          </Field>
          <Field id="agent-chapter" label={t('agents.chapterId')}>
            <TextInput
              id="agent-chapter"
              value={draft.chapterId}
              onChange={(event) => setField('chapterId', event.target.value)}
            />
          </Field>
          <Field id="agent-state" label={t('agents.state')}>
            <TextInput
              id="agent-state"
              value={draft.state}
              onChange={(event) => setField('state', event.target.value)}
              placeholder="Kaduna"
            />
          </Field>
          <Field id="agent-lga" label={t('agents.lga')}>
            <TextInput
              id="agent-lga"
              value={draft.lga}
              onChange={(event) => setField('lga', event.target.value)}
              placeholder="Zaria"
            />
          </Field>
          <Field id="agent-purpose" label={t('agents.purpose')}>
            <TextInput
              id="agent-purpose"
              value={draft.purpose}
              onChange={(event) => setField('purpose', event.target.value)}
              placeholder="farmer-registration"
            />
          </Field>
          <Field id="agent-target" label={t('agents.targetCount')}>
            <TextInput
              id="agent-target"
              inputMode="numeric"
              value={draft.targetCount}
              onChange={(event) => setField('targetCount', event.target.value)}
            />
          </Field>
        </div>
        {formError ? <p role="alert">{formError}</p> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={createMutation.status === 'pending'}
          onClick={() => void submitCreate()}
        >
          {createMutation.status === 'pending' ? t('agents.creating') : t('agents.create')}
        </button>
      </section>

      <section aria-labelledby="agents-board">
        <h2 id="agents-board">{t('agents.boardTitle')}</h2>
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          data={board.data}
          onRetry={board.refresh}
          empty={<EmptyState title={t('agents.empty')} />}
        >
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {(board.data ?? []).map((assignment) => (
              <li key={assignment.id} className="card">
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <strong>{assignment.purpose}</strong>
                  <StatusBadge tone={STATUS_TONES[assignment.status]}>
                    {t(STATUS_LABEL_KEYS[assignment.status])}
                  </StatusBadge>
                </div>
                <p className="small soft">
                  {assignment.agentUserId} · {assignment.state} / {assignment.lga}
                  {assignment.ward ? ` / ${assignment.ward}` : ''}
                </p>
                <ProgressBar
                  value={progressPercent(assignment)}
                  label={t('agents.progressLabel', {
                    completed: assignment.completedCount,
                    target: assignment.targetCount
                  })}
                />
                {assignment.status === 'assigned' || assignment.status === 'in_progress' ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={cancelMutation.status === 'pending'}
                    onClick={() => void cancelMutation.mutate(assignment.id)}
                  >
                    {t('agents.cancel')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </QueryState>
        {cancelMutation.status === 'error' ? (
          <ApiErrorNotice error={cancelMutation.error} />
        ) : null}
      </section>

      {role === 'admin' ? (
        <section aria-labelledby="agents-productivity">
          <h2 id="agents-productivity">{t('agents.productivityTitle')}</h2>
          <QueryState
            isLoading={productivity.isLoading}
            error={productivity.error}
            data={productivity.data}
            onRetry={productivity.refresh}
            empty={<EmptyState title={t('agents.productivityEmpty')} />}
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('agents.colAgent')}</th>
                    <th>{t('agents.colActive')}</th>
                    <th>{t('agents.colCompleted')}</th>
                    <th>{t('agents.colCancelled')}</th>
                    <th>{t('agents.colTarget')}</th>
                    <th>{t('agents.colDone')}</th>
                    <th>{t('agents.colRate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(productivity.data ?? []).map((row) => (
                    <tr key={row.agentUserId}>
                      <td>{row.agentUserId}</td>
                      <td>{row.activeAssignments}</td>
                      <td>{row.completedAssignments}</td>
                      <td>{row.cancelledAssignments}</td>
                      <td>{row.targetCount}</td>
                      <td>{row.completedCount}</td>
                      <td>{Math.round(row.completionRate * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </section>
      ) : null}
    </div>
  );
}
