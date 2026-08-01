'use client';

import { useMemo, useState } from 'react';
import {
  NIGERIAN_STATES,
  VALUE_CHAINS,
  opportunityMatchesProfile,
  seedOpportunities
} from '@agric-platform/shared';
import type { Opportunity } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useSession } from '@/lib/session';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  applyToOpportunity,
  listApplications,
  listOpportunities
} from '@/lib/api/endpoints';
import { usePersistentState } from '@/lib/use-persistent-state';
import { Field, Select, TextInput } from '@/components/forms';
import { EmptyState, StatusBadge } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallback only: shown when the API is unreachable and nothing is
// cached. Live data always comes from GET /api/v1/opportunities.
const FALLBACK_OPPORTUNITIES: Opportunity[] = seedOpportunities;

const TYPES = ['grant', 'loan', 'programme', 'job', 'internship', 'competition', 'equipment', 'land'] as const;

export function OpportunityBrowser() {
  const { userId } = useAppState();
  const { hydrated } = useSession();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [chain, setChain] = useState('');
  const [profile] = usePersistentState<{ state?: string; valueChains?: string[] }>(
    'agric.onboarding-draft',
    {}
  );

  const opportunitiesQuery = useApiQuery(
    hydrated ? `opportunities:${type}:${state}:${chain}` : null,
    () =>
      listOpportunities({
        type: (type || undefined) as Opportunity['type'] | undefined,
        state: state || undefined,
        valueChain: chain || undefined,
        active: true,
        pageSize: 100
      }).then((res) => res.data),
    { fallbackData: FALLBACK_OPPORTUNITIES, enabled: hydrated }
  );

  const applicationsQuery = useApiQuery(
    hydrated ? `applications:${userId}` : null,
    () => listApplications({ userId }).then((res) => res.data),
    { fallbackData: [], enabled: hydrated }
  );

  const applyMutation = useApiMutation<{ opportunity: Opportunity }, unknown>({
    mutationFn: ({ opportunity }) =>
      applyToOpportunity(opportunity.id, { userId }).then((res) => res.data),
    queue: {
      kind: 'opportunity.application.submitted',
      label: ({ opportunity }) => `Application: ${opportunity.title}`,
      method: 'POST',
      path: ({ opportunity }) => `/opportunities/${opportunity.id}/apply`,
      payload: () => ({ userId })
    },
    onSuccess: () => applicationsQuery.refresh(),
    onQueued: () => applicationsQuery.refresh()
  });

  const appliedIds = useMemo(() => {
    const ids = new Set((applicationsQuery.data ?? []).map((app) => app.opportunityId));
    return ids;
  }, [applicationsQuery.data]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (opportunitiesQuery.data ?? [])
      .filter((opp) => {
        if (!opp.isActive) return false;
        if (type && opp.type !== type) return false;
        if (state && !opp.states.includes(state)) return false;
        if (chain && !opp.valueChains.includes(chain)) return false;
        if (needle && !`${opp.title} ${opp.description}`.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
  }, [opportunitiesQuery.data, query, type, state, chain]);

  const clearFilters = () => {
    setQuery('');
    setType('');
    setState('');
    setChain('');
  };

  return (
    <div className="stack-lg">
      {opportunitiesQuery.source === 'fallback' ? <OfflineDataNotice /> : null}
      <fieldset className="card filter-card">
        <legend>Filter opportunities</legend>
        <div className="form-grid cols-2">
          <Field id="opp-q" label="Search">
            <TextInput
              id="opp-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search grants, programmes, jobs…"
              type="search"
            />
          </Field>
          <Field id="opp-type" label="Type">
            <Select id="opp-type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="opp-state" label="State">
            <Select id="opp-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All states</option>
              {NIGERIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="opp-chain" label="Value chain">
            <Select id="opp-chain" value={chain} onChange={(e) => setChain(e.target.value)}>
              <option value="">All value chains</option>
              {VALUE_CHAINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="cluster" style={{ marginTop: '0.9rem', justifyContent: 'space-between' }}>
          <span className="small muted" role="status" aria-live="polite">
            {results.length} opportunit{results.length === 1 ? 'y' : 'ies'} found
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </fieldset>

      <QueryState
        isLoading={opportunitiesQuery.isLoading}
        error={opportunitiesQuery.source === 'fallback' ? undefined : opportunitiesQuery.error}
        data={results}
        onRetry={opportunitiesQuery.refresh}
        empty={
          <EmptyState
            title="No opportunities match these filters"
            hint="Try widening the state or value chain filters."
          />
        }
      >
        <div className="grid grid-2">
          {results.map((opp) => {
            const matches = opportunityMatchesProfile({
              opportunityStates: opp.states,
              opportunityValueChains: opp.valueChains,
              profileState: profile.state,
              profileValueChains: profile.valueChains
            });
            const hasApplied = appliedIds.has(opp.id);
            return (
              <article className="card" key={opp.id}>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <StatusBadge tone="info">{opp.type}</StatusBadge>
                  {matches ? <StatusBadge tone="success">matches your profile</StatusBadge> : null}
                </div>
                <h3 style={{ marginTop: '0.6rem' }}>{opp.title}</h3>
                <p className="small muted">{opp.description}</p>
                <p className="small">
                  <strong>Eligibility:</strong> {opp.eligibility.join(' · ')}
                </p>
                <p className="small muted">
                  {opp.states.length > 6 ? 'Nationwide' : opp.states.join(', ')} ·{' '}
                  {opp.valueChains.join(', ')}
                </p>
                <div className="cluster" style={{ justifyContent: 'space-between', marginTop: '0.5rem' }}>
                  <span className="small" style={{ fontWeight: 600 }}>
                    Deadline: {new Date(opp.deadline).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                  </span>
                  <button
                    type="button"
                    className={`btn btn-small ${hasApplied ? 'btn-secondary' : 'btn-primary'}`}
                    disabled={hasApplied || applyMutation.status === 'pending'}
                    aria-label={
                      hasApplied
                        ? `Applied to ${opp.title}`
                        : `Apply for ${opp.title}`
                    }
                    onClick={() => void applyMutation.mutate({ opportunity: opp })}
                  >
                    {hasApplied ? 'Applied' : applyMutation.status === 'pending' ? 'Applying…' : 'Apply'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </QueryState>
    </div>
  );
}
