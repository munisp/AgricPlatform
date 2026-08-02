import type { ApiListResponse, ServiceSupplier, SupplierCategory } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface SupplierCriteria {
  category?: SupplierCategory;
  state?: string;
  verificationStatus?: ServiceSupplier['verificationStatus'];
  ownerUserId?: string;
}

export interface SupplierRepository extends AsyncRepository<ServiceSupplier, SupplierCriteria> {
  searchPage(
    criteria: SupplierCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<ServiceSupplier>>;
}

export function supplierMatcher(criteria: SupplierCriteria): (supplier: ServiceSupplier) => boolean {
  return (supplier) =>
    (!criteria.category || supplier.categories.includes(criteria.category)) &&
    (!criteria.state || supplier.statesCovered.includes(criteria.state)) &&
    (!criteria.verificationStatus || supplier.verificationStatus === criteria.verificationStatus) &&
    (!criteria.ownerUserId || supplier.ownerUserId === criteria.ownerUserId);
}

export class InMemorySupplierRepository
  extends InMemoryRepository<ServiceSupplier, SupplierCriteria>
  implements SupplierRepository
{
  constructor(seed: readonly ServiceSupplier[] = []) {
    super(seed, supplierMatcher);
  }
}

export function createInMemorySupplierRepository(): InMemorySupplierRepository {
  return new InMemorySupplierRepository();
}
