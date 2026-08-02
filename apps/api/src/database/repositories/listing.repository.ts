import type { ApiListResponse, MarketplaceListing } from '@agric-platform/shared';
import { seedListings } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { ilike, InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ListingCriteria {
  kind?: MarketplaceListing['kind'];
  state?: string;
  crop?: string;
  active?: boolean;
  q?: string;
}

export interface ListingRepository extends AsyncRepository<MarketplaceListing, ListingCriteria> {
  searchPage(
    criteria: ListingCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<MarketplaceListing>>;
  activeListingCount(): Promise<number>;
  /**
   * Atomic stock increment (Wave M cancel-with-restock / RMA restock):
   * compiled to `quantity = quantity + $n` on pg so concurrent restocks
   * never lose increments.
   */
  restock(id: string, quantity: number): Promise<MarketplaceListing>;
}

export function listingMatcher(criteria: ListingCriteria): (listing: MarketplaceListing) => boolean {
  return (listing) =>
    (!criteria.kind || listing.kind === criteria.kind) &&
    (!criteria.state || listing.location.state === criteria.state) &&
    (!criteria.crop || listing.crop === criteria.crop) &&
    (criteria.active === undefined || listing.isActive === criteria.active) &&
    (!criteria.q || ilike(listing.title, criteria.q));
}

export class InMemoryListingRepository
  extends InMemoryRepository<MarketplaceListing, ListingCriteria>
  implements ListingRepository
{
  constructor(seed: readonly MarketplaceListing[] = []) {
    super(seed, listingMatcher);
  }

  async activeListingCount(): Promise<number> {
    return this.count({ active: true });
  }

  /** Synchronous check-and-set increment mirroring the pg atomic UPDATE. */
  async restock(id: string, quantity: number): Promise<MarketplaceListing> {
    const current = await this.getById(id);
    const next = { ...current, quantity: current.quantity + quantity };
    return this.update(id, { quantity: next.quantity });
  }
}

export function createInMemoryListingRepository(): InMemoryListingRepository {
  return new InMemoryListingRepository(seedListings);
}
