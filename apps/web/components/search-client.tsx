'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatNaira, seedAdvisory, seedChapters, seedCourses, seedListings, seedOpportunities } from '@agric-platform/shared';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchRelatedItems, fetchTrendingQueries, searchPlatform } from '@/lib/api/endpoints';
import type { SearchResult } from '@/lib/api/endpoints';
import { TextInput } from '@/components/forms';
import { EmptyState, StatusBadge } from '@/components/ui';

interface SearchEntry {
  id: string;
  group: string;
  title: string;
  detail: string;
  href: string;
  badge?: string;
  /** Set for live API results — enables the "related items" detail. */
  resultType?: SearchResult['type'];
  resultId?: string;
}

const INDEX: SearchEntry[] = [
  ...seedCourses.map((course) => ({
    id: course.id,
    group: 'Learning',
    title: course.title,
    detail: `${course.category} · ${course.level} · ${course.durationMinutes} min`,
    href: '/learning',
    badge: course.offlineAvailable ? 'offline-ready' : 'online only'
  })),
  ...seedOpportunities.map((opp) => ({
    id: opp.id,
    group: 'Opportunities',
    title: opp.title,
    detail: `${opp.type} · deadline ${new Date(opp.deadline).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`,
    href: '/opportunities',
    badge: opp.type
  })),
  ...seedChapters.map((chapter) => ({
    id: chapter.id,
    group: 'Chapters',
    title: chapter.name,
    detail: `${chapter.level} · ${chapter.memberCount.toLocaleString('en-NG')} members`,
    href: '/chapters',
    badge: chapter.level
  })),
  ...seedListings.map((listing) => ({
    id: listing.id,
    group: 'Marketplace',
    title: listing.title,
    detail: `${formatNaira(listing.priceNaira)} · ${listing.location.state}`,
    href: '/marketplace',
    badge: listing.kind
  })),
  ...seedAdvisory.map((item) => ({
    id: item.id,
    group: 'Advisory',
    title: item.title,
    detail: [item.state, item.crop, item.kind.replace(/_/g, ' ')].filter(Boolean).join(' · '),
    href: '/advisory',
    badge: item.severity ?? 'info'
  }))
];

const TYPE_META: Record<SearchResult['type'], { group: string; href: string }> = {
  course: { group: 'Learning', href: '/learning' },
  opportunity: { group: 'Opportunities', href: '/opportunities' },
  listing: { group: 'Marketplace', href: '/marketplace' },
  advisory: { group: 'Advisory', href: '/advisory' },
  chapter: { group: 'Chapters', href: '/chapters' },
  topic: { group: 'Community', href: '/community' }
};

/** Related items for one API result (shared-tag co-occurrence). */
function RelatedItems({ entry }: { entry: SearchEntry }) {
  const [open, setOpen] = useState(false);
  const query = useApiQuery(
    open && entry.resultType && entry.resultId
      ? `related:${entry.resultType}:${entry.resultId}`
      : null,
    () =>
      fetchRelatedItems({ type: entry.resultType!, id: entry.resultId!, limit: 5 }).then(
        (res) => res.data
      ),
    { enabled: open, fallbackData: [] }
  );

  if (!entry.resultType || !entry.resultId) return null;

  return (
    <div style={{ marginTop: '0.35rem' }}>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Related items for ${entry.title}`}
      >
        {open ? 'Hide related' : 'Related'}
      </button>
      {open ? (
        query.data && query.data.length > 0 ? (
          <ul className="row-list" style={{ marginTop: '0.35rem' }}>
            {query.data.map((item) => (
              <li className="row-item" key={`${item.type}-${item.id}`}>
                <div className="row-main">
                  <Link href={TYPE_META[item.type].href} className="row-title">
                    {item.title}
                  </Link>
                  <div className="small muted">{item.summary}</div>
                </div>
                <StatusBadge tone="neutral">{item.type}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : query.error ? (
          <p className="small muted" role="status">
            Related items are unavailable offline.
          </p>
        ) : (
          <p className="small muted">No related items yet.</p>
        )
      ) : null}
    </div>
  );
}

/** Trending queries strip (decayed 7-day counts) — doubles as quick search. */
function TrendingStrip({ onPick }: { onPick: (query: string) => void }) {
  const query = useApiQuery(
    'search:trending',
    () => fetchTrendingQueries({ limit: 6 }).then((res) => res.data),
    { fallbackData: [], staleTimeMs: 120_000 }
  );

  if (!query.data || query.data.length === 0) return null;

  return (
    <section aria-label="Trending searches">
      <h3 className="small" style={{ marginBottom: '0.35rem' }}>
        Trending now
      </h3>
      <div className="cluster" role="list">
        {query.data.map((trend) => (
          <button
            key={trend.query}
            type="button"
            role="listitem"
            className="btn btn-ghost btn-small"
            onClick={() => onPick(trend.query)}
            aria-label={`Search for trending topic ${trend.query}`}
          >
            {trend.query}
          </button>
        ))}
      </div>
    </section>
  );
}

export function SearchClient() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const needle = debounced.trim();

  // Live cross-domain search (GET /api/v1/search?q=…). On failure the local
  // fixture index below keeps search working offline.
  const apiQuery = useApiQuery(
    needle.length >= 2 ? `search:${needle.toLowerCase()}` : null,
    () => searchPlatform({ q: needle, limit: 30 }).then((res) => res.data),
    { staleTimeMs: 60_000 }
  );

  const groups = useMemo(() => {
    if (needle.length < 2) return [];

    let hits: SearchEntry[];
    if (apiQuery.data && !apiQuery.error) {
      hits = apiQuery.data.map((result) => ({
        id: `${result.type}-${result.id}`,
        group: TYPE_META[result.type].group,
        title: result.title,
        detail: result.summary,
        href: TYPE_META[result.type].href,
        badge: result.type,
        resultType: result.type,
        resultId: result.id
      }));
    } else {
      const lower = needle.toLowerCase();
      hits = INDEX.filter(
        (entry) =>
          entry.title.toLowerCase().includes(lower) || entry.detail.toLowerCase().includes(lower)
      );
    }

    const byGroup = new Map<string, SearchEntry[]>();
    for (const hit of hits) {
      const list = byGroup.get(hit.group) ?? [];
      list.push(hit);
      byGroup.set(hit.group, list);
    }
    return [...byGroup.entries()];
  }, [needle, apiQuery.data, apiQuery.error]);

  return (
    <div className="stack-lg">
      <div className="field">
        <label className="label" htmlFor="search-input">
          Search the platform
        </label>
        <TextInput
          id="search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try “cassava”, “grant”, “Kano”, “poultry”…"
          aria-describedby="search-hint"
        />
        <span className="hint" id="search-hint">
          Searches courses, opportunities, chapters, listings and advisory — works offline on cached data.
        </span>
      </div>

      {needle.length < 2 ? <TrendingStrip onPick={(picked) => setQuery(picked)} /> : null}

      {needle.length >= 2 && apiQuery.error ? (
        <p className="notice notice-info" role="status">
          Search service unreachable — searching cached offline data instead.
        </p>
      ) : null}

      {needle.length >= 2 && groups.length === 0 ? (
        <EmptyState title={`No results for “${needle}”`} hint="Check spelling or try a broader term." />
      ) : null}

      {groups.map(([group, entries]) => (
        <section key={group} aria-label={`${group} results`}>
          <h3>
            {group} <span className="muted small">({entries.length})</span>
          </h3>
          <ul className="row-list">
            {entries.map((entry) => (
              <li className="row-item" key={entry.id}>
                <div className="row-main">
                  <Link href={entry.href} className="row-title">
                    {entry.title}
                  </Link>
                  <div className="small muted">{entry.detail}</div>
                  <RelatedItems entry={entry} />
                </div>
                {entry.badge ? <StatusBadge tone="neutral">{entry.badge}</StatusBadge> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
