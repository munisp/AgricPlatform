'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CertifiedListing, MarketplaceListing } from '@agric-platform/shared';
import { fetchCertifiedListing } from '@/lib/api/endpoints';
import { StatusBadge } from '@/components/ui';

/**
 * Livestock-crop heuristic: a marketplace listing only attempts a certified-
 * listing lookup when its crop names a livestock product (crop listings never
 * hit the API). The marketplace ↔ certified-listing link is the listing ID —
 * where no certified listing exists (all crop listings, uncertified animals)
 * the lookup 404s and the badge stays absent.
 */
const LIVESTOCK_CROP_TERMS = [
  'cattle',
  'beef',
  'sheep',
  'ram',
  'goat',
  'chicken',
  'poultry',
  'broiler',
  'layer',
  'noiler',
  'pig',
  'livestock'
];

function isLivestockListing(listing: MarketplaceListing): boolean {
  const haystack = `${listing.crop ?? ''} ${listing.title}`.toLowerCase();
  return LIVESTOCK_CROP_TERMS.some((term) => haystack.includes(term));
}

/**
 * Provenance badge for livestock-certified marketplace listings. Renders
 * nothing for crop listings or uncertified animals (graceful absence).
 */
export function LivestockProvenanceBadge({ listing }: { listing: MarketplaceListing }) {
  const [certified, setCertified] = useState<CertifiedListing | null>(null);

  useEffect(() => {
    if (!isLivestockListing(listing)) return;
    let cancelled = false;
    fetchCertifiedListing(listing.id)
      .then((res) => {
        if (!cancelled) setCertified(res.data);
      })
      .catch(() => {
        // 404 (not livestock-certified) or offline — the badge simply stays absent.
      });
    return () => {
      cancelled = true;
    };
  }, [listing]);

  if (!certified) return null;

  return (
    <p style={{ margin: '0.5rem 0 0' }}>
      <Link
        href={`/livestock/trade#certified-${certified.id}`}
        aria-label={`Livestock provenance: ${certified.species}${
          certified.breed ? `, ${certified.breed}` : ''
        }, ${certified.provenance.ownershipDepth} recorded transfers — view certified listing`}
      >
        <StatusBadge tone="success">
          ALTP certified · {certified.provenance.ownershipDepth} transfer
          {certified.provenance.ownershipDepth === 1 ? '' : 's'} · view provenance
        </StatusBadge>
      </Link>
    </p>
  );
}
