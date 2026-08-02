import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LivestockLot, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryLotRepository } from '../../database/repositories/livestock.repository.js';
import { createInMemoryAggregationPointRepository } from '../../database/repositories/livestock-trade.repository.js';
import { AggregationPointsService } from './aggregation-points.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const manager = asUser('partner-1', ['partner']);
const otherPartner = asUser('partner-2', ['partner']);
const admin = asUser('admin-1', ['admin']);

const cattleLot: LivestockLot = {
  id: 'LOT-BOV-KD-000001',
  species: 'cattle',
  quantity: 40,
  ownerUserId: 'farmer-1',
  state: 'Kaduna',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const cattleLot2: LivestockLot = { ...cattleLot, id: 'LOT-BOV-KD-000002', quantity: 70 };
const goatLot: LivestockLot = {
  ...cattleLot,
  id: 'LOT-CAP-KD-000003',
  species: 'goat',
  quantity: 10
};

describe('AggregationPointsService', () => {
  let points: ReturnType<typeof createInMemoryAggregationPointRepository>;
  let lots: ReturnType<typeof createInMemoryLotRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let service: AggregationPointsService;

  const input = { name: 'Zaria cattle hub', state: 'Kaduna', lga: 'Zaria', capacity: 100 };

  beforeEach(() => {
    points = createInMemoryAggregationPointRepository();
    lots = createInMemoryLotRepository([cattleLot, cattleLot2, goatLot]);
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    service = new AggregationPointsService(
      audit as never,
      new DomainEventsService(outbox),
      points,
      lots
    );
  });

  it('registers a point (partner manager or admin) with validation', async () => {
    const point = await service.create(manager, input);
    expect(point.status).toBe('active');
    expect(point.managerUserId).toBe(manager.id);
    expect(point.lotIds).toEqual([]);
    await expect(service.create(asUser('farmer-1', ['farmer']), input)).rejects.toThrow(
      'Requires one of roles'
    );
    await expect(service.create(manager, { ...input, state: 'Atlantis' })).rejects.toThrow(
      'Unknown Nigerian state'
    );
    await expect(service.create(manager, { ...input, capacity: 0 })).rejects.toThrow('capacity');
  });

  it('assigns lots and publishes a logistics event', async () => {
    const point = await service.create(manager, input);
    const updated = await service.assignLot(manager, point.id, cattleLot.id);
    expect(updated.lotIds).toEqual([cattleLot.id]);
    const events = await outbox.list();
    const assigned = events.find(
      (event) => event.name === 'livestock_trade.aggregation.lot_assigned'
    );
    expect(assigned?.payload).toMatchObject({
      pointId: point.id,
      lotId: cattleLot.id,
      species: 'cattle',
      quantity: 40
    });
  });

  it('enforces single-species consistency across assigned lots', async () => {
    const point = await service.create(manager, input);
    await service.assignLot(manager, point.id, cattleLot.id);
    await expect(service.assignLot(manager, point.id, goatLot.id)).rejects.toThrow(
      'holds cattle lots'
    );
  });

  it('enforces capacity against summed lot quantities', async () => {
    const point = await service.create(manager, input); // capacity 100
    await service.assignLot(manager, point.id, cattleLot.id); // 40
    await expect(service.assignLot(manager, point.id, cattleLot2.id)).rejects.toThrow(
      'exceeds the capacity'
    );
    const roomy = await service.create(manager, { ...input, name: 'bigger', capacity: 120 });
    await service.assignLot(manager, roomy.id, cattleLot.id);
    await expect(service.assignLot(manager, roomy.id, cattleLot2.id)).resolves.toMatchObject({
      lotIds: [cattleLot.id, cattleLot2.id]
    });
  });

  it('rejects duplicate assignment and assignment by non-managers', async () => {
    const point = await service.create(manager, input);
    await service.assignLot(manager, point.id, cattleLot.id);
    await expect(service.assignLot(manager, point.id, cattleLot.id)).rejects.toThrow(
      'already assigned'
    );
    await expect(service.assignLot(otherPartner, point.id, cattleLot2.id)).rejects.toThrow(
      'You may only access your own records'
    );
  });

  it('unassigns lots and blocks assignment on inactive points', async () => {
    const point = await service.create(manager, input);
    await service.assignLot(manager, point.id, cattleLot.id);
    const updated = await service.unassignLot(manager, point.id, cattleLot.id);
    expect(updated.lotIds).toEqual([]);
    await expect(service.unassignLot(manager, point.id, cattleLot.id)).rejects.toThrow(
      'not assigned'
    );
    await service.deactivate(manager, point.id);
    await expect(service.assignLot(manager, point.id, cattleLot.id)).rejects.toThrow('inactive');
    // Admin can still manage the point.
    await expect(service.unassignLot(admin, point.id, cattleLot.id)).rejects.toThrow(
      'not assigned'
    );
  });

  it('lists active points by state and by manager', async () => {
    await service.create(manager, input);
    await service.create(otherPartner, { ...input, name: 'Kano hub', state: 'Kano', lga: 'Kano' });
    expect(await service.list(manager, 'Kaduna')).toHaveLength(1);
    expect(await service.list(manager)).toHaveLength(2);
    expect(await service.listMine(otherPartner)).toHaveLength(1);
  });
});
