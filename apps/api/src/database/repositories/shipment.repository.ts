import type { Shipment, ShipmentStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ShipmentCriteria {
  orderId?: string;
  status?: ShipmentStatus;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ShipmentRepository extends AsyncRepository<Shipment, ShipmentCriteria> {}

export function shipmentMatcher(criteria: ShipmentCriteria): (shipment: Shipment) => boolean {
  return (shipment) =>
    (!criteria.orderId || shipment.orderId === criteria.orderId) &&
    (!criteria.status || shipment.status === criteria.status);
}

export class InMemoryShipmentRepository
  extends InMemoryRepository<Shipment, ShipmentCriteria>
  implements ShipmentRepository
{
  constructor(seed: readonly Shipment[] = []) {
    super(seed, shipmentMatcher);
  }
}

export function createInMemoryShipmentRepository(): InMemoryShipmentRepository {
  return new InMemoryShipmentRepository();
}
