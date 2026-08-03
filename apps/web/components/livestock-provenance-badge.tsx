'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { MarketplaceListing } from '@agric-platform/shared';
import {
  fetchCertifiedListing,
  fetchCertifiedProvenance,
  type CertifiedProvenanceSummary
} from '@/lib/api/endpoints';
import { StatusBadge } from '@/components/ui';

/**
 * Livestock-crop heuristic (LEGACY fallback): marketplace listings created
 * before migration 019a have no direct certified-listing link, so they only
 * attempt a certified-listing lookup when the crop names a livestock
 * product. New listings carry `certifiedListingId` and never need this.
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

interface BadgeData {
  id: string;
  species: string;
  breed?: string;
  ownershipDepth: number;
}

/**
 * Provenance badge for livestock-certified marketplace listings. Prefers the
 * direct `certifiedListingId` link (migration 019a, public provenance API —
 * no auth needed); falls back to the legacy crop-term heuristic for older
 * listings. Renders nothing when no certification exists (graceful absence).
 */
export function LivestockProvenanceBadge({ listing }: { listing: MarketplaceListing }) {
  const [badge, setBadge] = useState<BadgeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (listing.certifiedListingId) {
      // Direct link: the public provenance summary is the source of truth.
      fetchCertifiedProvenance(listing.certifiedListingId)
        .then((res) => {
          if (cancelled) return;
          const summary: CertifiedProvenanceSummary = res.data;
          setBadge({
            id: summary.listingId,
            species: summary.species,
            breed: summary.breed,
            ownershipDepth: summary.ownershipDepth
          });
        })
        .catch(() => {
          // 404 (draft/withdrawn/unknown) or offline — badge stays absent.
        });
      return () => {
        cancelled = true;
      };
    }
    if (!isLivestockListing(listing)) return;
    // Legacy fallback: pre-019a listings matched certified listing by id.
    fetchCertifiedListing(listing.id)
      .then((res) => {
        if (cancelled) return;
        setBadge({
          id: res.data.id,
          species: res.data.species,
          breed: res.data.breed,
          ownershipDepth: res.data.provenance.ownershipDepth
        });
      })
      .catch(() => {
        // 404 (not livestock-certified) or offline — the badge simply stays absent.
      });
    return () => {
      cancelled = true;
    };
  }, [listing]);

  if (!badge) return null;

  return (
    <p style={{ margin: '0.5rem 0 0' }}>
      <Link
        href={`/livestock/trade#certified-${badge.id}`}
        aria-label={`Livestock provenance: ${badge.species}${
          badge.breed ? `, ${badge.breed}` : ''
        }, ${badge.ownershipDepth} recorded transfers — view certified listing`}
      >
        <StatusBadge tone="success">
          ALTP certified · {badge.ownershipDepth} transfer
          {badge.ownershipDepth === 1 ? '' : 's'} · view provenance
        </StatusBadge>
      </Link>
    </p>
  );
}
