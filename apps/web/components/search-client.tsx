'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatNaira, seedAdvisory, seedChapters, seedCourses, seedListings, seedOpportunities } from '@agric-platform/shared';
import { extraOpportunities } from '@/lib/content';
import { TextInput } from '@/components/forms';
import { EmptyState, StatusBadge } from '@/components/ui';

interface SearchEntry {
  id: string;
  group: string;
  title: string;
  detail: string;
  href: string;
  badge?: string;
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
  ...[...seedOpportunities, ...extraOpportunities].map((opp) => ({
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

export function SearchClient() {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const hits = INDEX.filter(
      (entry) =>
        entry.title.toLowerCase().includes(needle) || entry.detail.toLowerCase().includes(needle)
    );
    const byGroup = new Map<string, SearchEntry[]>();
    for (const hit of hits) {
      const list = byGroup.get(hit.group) ?? [];
      list.push(hit);
      byGroup.set(hit.group, list);
    }
    return [...byGroup.entries()];
  }, [query]);

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
          autoFocus
          aria-describedby="search-hint"
        />
        <span className="hint" id="search-hint">
          Searches courses, opportunities, chapters, listings and advisory — works offline on cached data.
        </span>
      </div>

      {query.trim().length >= 2 && groups.length === 0 ? (
        <EmptyState title={`No results for “${query.trim()}”`} hint="Check spelling or try a broader term." />
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
