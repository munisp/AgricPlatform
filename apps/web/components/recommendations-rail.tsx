'use client';

import { useState } from 'react';
import { useApiQuery } from '@/lib/api/hooks';
import {
  fetchRecommendations,
  sendRecommendationFeedback
} from '@/lib/api/endpoints';
import type {
  RecommendationFeedbackAction,
  RecommendationReason,
  RecommendedItem
} from '@/lib/api/endpoints';
import { Section, StatusBadge } from '@/components/ui';

/**
 * "Recommended for you" strip on the member dashboard (GET /recommendations).
 * Renders nothing when the rail is empty or the API is unreachable — the
 * dashboard stays useful without it. Feedback (clicked/dismissed) posts to
 * /recommendations/:id/feedback with optimistic UI and saved/saving/failed
 * states; a failed dismiss restores the card.
 */

export const REASON_LABELS: Record<RecommendationReason, string> = {
  same_crop: 'Matches your crops',
  state_match: 'In your state',
  lga_match: 'Near you',
  value_chain_match: 'Matches your value chain',
  category_affinity: 'Similar to your courses',
  purchased_category: 'Based on your orders',
  completed_prerequisite: 'You finished the prerequisite',
  trending_fallback: 'Trending now'
};

export function humaniseReason(reason: RecommendationReason): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

const TYPE_LABELS: Record<RecommendedItem['type'], string> = {
  course: 'Course',
  opportunity: 'Opportunity',
  listing: 'Listing',
  knowledge: 'Resource'
};

type FeedbackState = 'idle' | 'saving' | 'saved';

function RecommendationCard({
  item,
  failed,
  onFeedback
}: {
  item: RecommendedItem;
  /** Set by the rail when the last feedback post for this item failed. */
  failed: boolean;
  onFeedback: (
    item: RecommendedItem,
    action: RecommendationFeedbackAction
  ) => Promise<boolean>;
}) {
  const [state, setState] = useState<FeedbackState>('idle');
  const [lastAction, setLastAction] = useState<RecommendationFeedbackAction | null>(null);

  const send = async (action: RecommendationFeedbackAction) => {
    setState('saving');
    setLastAction(action);
    const ok = await onFeedback(item, action);
    // On failure the rail flags the item; the card stays interactive for a retry.
    setState(ok ? 'saved' : 'idle');
  };

  return (
    <article className="card reco-card" data-testid={`reco-${item.id}`}>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <StatusBadge tone="info">{TYPE_LABELS[item.type]}</StatusBadge>
        {state === 'saved' && lastAction === 'clicked' ? (
          <StatusBadge tone="success">saved</StatusBadge>
        ) : null}
      </div>
      <h3 style={{ marginBottom: '0.25rem' }}>{item.title}</h3>
      <p className="small muted">{item.summary}</p>
      {item.reasons.length > 0 ? (
        <ul className="cluster" aria-label="Why this was recommended" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {item.reasons.slice(0, 3).map((reason) => (
            <li key={reason}>
              <span className="reco-chip">{humaniseReason(reason)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        {failed ? (
          <span className="small" role="alert" style={{ color: 'var(--red-600)' }}>
            Feedback not saved — try again.
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={state === 'saving'}
          onClick={() => void send('dismissed')}
        >
          {state === 'saving' && lastAction === 'dismissed' ? 'Dismissing…' : 'Not interested'}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={state === 'saving'}
          onClick={() => void send('clicked')}
        >
          {state === 'saving' && lastAction === 'clicked' ? 'Saving…' : 'View'}
        </button>
      </div>
    </article>
  );
}

export function RecommendationsRail() {
  const query = useApiQuery(
    'recommendations:dashboard',
    () => fetchRecommendations({ limit: 6 }).then((res) => res.data),
    { staleTimeMs: 60_000 }
  );
  // Optimistically dismissed ids; a failed dismiss un-hides the card.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Ids whose last feedback post failed — flagged on the restored card.
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());

  const handleFeedback = async (
    item: RecommendedItem,
    action: RecommendationFeedbackAction
  ): Promise<boolean> => {
    setFailedIds((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    if (action === 'dismissed') {
      setDismissed((prev) => new Set(prev).add(item.id));
    }
    try {
      await sendRecommendationFeedback(item.id, { type: item.type, action });
      return true;
    } catch {
      if (action === 'dismissed') {
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
      setFailedIds((prev) => new Set(prev).add(item.id));
      return false;
    }
  };

  const items = (query.data ?? []).filter((item) => !dismissed.has(item.id));

  // Hidden gracefully: no data (cold API, offline, empty rail) → render nothing.
  if (items.length === 0) {
    return null;
  }

  return (
    <Section kicker="For you" title="Recommended for you">
      <div className="reco-rail" role="list" aria-label="Recommended items">
        {items.map((item) => (
          <div role="listitem" key={`${item.type}-${item.id}`}>
            <RecommendationCard
              item={item}
              failed={failedIds.has(item.id)}
              onFeedback={handleFeedback}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}
