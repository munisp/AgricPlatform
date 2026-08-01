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
import { usePersistentState } from '@/lib/use-persistent-state';
import { extraOpportunities } from '@/lib/content';
import { Field, Select, TextInput } from '@/components/forms';
import { EmptyState, StatusBadge } from '@/components/ui';

const ALL_OPPORTUNITIES: Opportunity[] = [...seedOpportunities, ...extraOpportunities];

const TYPES = ['grant', 'loan', 'programme', 'job', 'internship', 'competition', 'equipment', 'land'] as const;

export function OpportunityBrowser() {
  const { enqueue } = useAppState();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [chain, setChain] = useState('');
  const [applied, setApplied] = usePersistentState<string[]>('agric.opportunity-applications', []);
  const [profile] = usePersistentState<{ state?: string; valueChains?: string[] }>(
    'agric.onboarding-draft',
    {}
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ALL_OPPORTUNITIES.filter((opp) => {
      if (!opp.isActive) return false;
      if (type && opp.type !== type) return false;
      if (state && !opp.states.includes(state)) return false;
      if (chain && !opp.valueChains.includes(chain)) return false;
      if (needle && !`${opp.title} ${opp.description}`.toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => a.deadline.localeCompare(b.deadline));
  }, [query, type, state, chain]);

  const apply = (opp: Opportunity) => {
    if (applied.includes(opp.id)) return;
    setApplied((current) => [...current, opp.id]);
    enqueue('opportunity.application.submitted', `Application: ${opp.title}`);
  };

  const clearFilters = () => {
    setQuery('');
    setType('');
    setState('');
    setChain('');
  };

  return (
    <div className="stack-lg">
      <div className="card">
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
          <span className="small muted" role="status">
            {results.length} opportunit{results.length === 1 ? 'y' : 'ies'} found
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState title="No opportunities match these filters" hint="Try widening the state or value chain filters." />
      ) : (
        <div className="grid grid-2">
          {results.map((opp) => {
            const matches = opportunityMatchesProfile({
              opportunityStates: opp.states,
              opportunityValueChains: opp.valueChains,
              profileState: profile.state,
              profileValueChains: profile.valueChains
            });
            const hasApplied = applied.includes(opp.id);
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
                    disabled={hasApplied}
                    onClick={() => apply(opp)}
                  >
                    {hasApplied ? 'Application queued' : 'Apply'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
