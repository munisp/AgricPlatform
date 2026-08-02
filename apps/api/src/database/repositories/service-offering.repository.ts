import type { ServiceOffering, SupplierCategory } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ServiceOfferingCriteria {
  supplierId?: string;
  category?: SupplierCategory;
  active?: boolean;
}

export type ServiceOfferingRepository = AsyncRepository<ServiceOffering, ServiceOfferingCriteria>;

export function serviceOfferingMatcher(
  criteria: ServiceOfferingCriteria
): (offering: ServiceOffering) => boolean {
  return (offering) =>
    (!criteria.supplierId || offering.supplierId === criteria.supplierId) &&
    (!criteria.category || offering.category === criteria.category) &&
    (criteria.active === undefined || offering.isActive === criteria.active);
}

export class InMemoryServiceOfferingRepository
  extends InMemoryRepository<ServiceOffering, ServiceOfferingCriteria>
  implements ServiceOfferingRepository
{
  constructor(seed: readonly ServiceOffering[] = []) {
    super(seed, serviceOfferingMatcher);
  }
}

export function createInMemoryServiceOfferingRepository(): InMemoryServiceOfferingRepository {
  return new InMemoryServiceOfferingRepository();
}
