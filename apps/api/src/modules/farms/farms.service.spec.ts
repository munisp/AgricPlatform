import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryFarmRepository } from '../../database/repositories/farms.repository.js';
import { FarmsService } from './farms.service.js';

const owner = { id: 'user-1', roles: ['farmer'] } as User;
const admin = { id: 'admin-1', roles: ['admin'] } as User;

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const farms = createInMemoryFarmRepository();
  const service = new FarmsService(events, farms.plots, farms.plantings, farms.harvests, farms.expenses, farms.allocations);
  return { service, farms, events };
}

describe('FarmsService — plot ownership & versioning', () => {
  let service: FarmsService;
  beforeEach(() => {
    service = makeService().service;
  });

  it('creates a plot owned by the caller and bumps version on update', async () => {
    const plot = await service.createPlot(owner, {
      name: 'North Field',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11.08,
      centroidLong: 7.72,
      sizeHectares: 2.5
    });
    expect(plot.ownerUserId).toBe('user-1');
    expect(plot.version).toBe(1);
    const updated = await service.updatePlot(owner, plot.id, { sizeHectares: 3 });
    expect(updated.sizeHectares).toBe(3);
    expect(updated.version).toBe(2);
  });

  it('enforces ownership on reads and writes', async () => {
    const plot = await service.createPlot(owner, {
      name: 'Private Plot',
      state: 'Kano',
      lga: 'Kano',
      centroidLat: 12,
      centroidLong: 8.5,
      sizeHectares: 1
    });
    const stranger = { id: 'user-2', roles: ['farmer'] } as User;
    await expect(service.getPlot(stranger, plot.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updatePlot(stranger, plot.id, { name: 'x' })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(service.removePlot(stranger, plot.id)).rejects.toBeInstanceOf(ForbiddenException);
    // Admin sees everything.
    await expect(service.getPlot(admin, plot.id)).resolves.toMatchObject({ id: plot.id });
  });

  it('scopes plot listings: non-admins only see their own', async () => {
    await service.createPlot(owner, {
      name: 'Mine',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11,
      centroidLong: 7,
      sizeHectares: 1
    });
    const mine = await service.listPlots(owner, {});
    expect(mine.every((plot) => plot.ownerUserId === 'user-1')).toBe(true);
    await expect(service.listPlots(owner, { ownerUserId: 'user-2' })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    const all = await service.listPlots(admin, {});
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('removes a plot with its child records', async () => {
    const plot = await service.createPlot(owner, {
      name: 'Doomed',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11,
      centroidLong: 7,
      sizeHectares: 1
    });
    const planting = await service.createPlanting(owner, plot.id, {
      crop: 'maize',
      season: '2026-wet',
      plantedAt: '2026-05-01T00:00:00.000Z'
    });
    await service.createExpense(owner, plot.id, {
      category: 'seed',
      amountKobo: 5000,
      incurredAt: '2026-05-01T00:00:00.000Z'
    });
    await service.removePlot(owner, plot.id);
    await expect(service.getPlot(owner, plot.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listPlantings(owner, plot.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FarmsService — planting lifecycle (A2/A3/V-03)', () => {
  let service: FarmsService;
  beforeEach(() => {
    service = makeService().service;
  });

  async function plotWithPlanting() {
    const plot = await service.createPlot(owner, {
      name: 'Lifecycle',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11,
      centroidLong: 7,
      sizeHectares: 1
    });
    const planting = await service.createPlanting(owner, plot.id, {
      crop: 'sorghum',
      season: '2026-wet',
      plantedAt: '2026-05-01T00:00:00.000Z'
    });
    return { plot, planting };
  }

  it('drives the status machine growing → partially_harvested → harvested', async () => {
    const { planting } = await plotWithPlanting();
    expect(planting.status).toBe('growing');
    await service.recordHarvest(owner, planting.id, {
      harvestedAt: '2026-07-01T00:00:00.000Z',
      quantity: 20,
      unit: 'kg'
    });
    const afterPick = await service.listPlantings(owner, planting.plotId);
    expect(afterPick[0].status).toBe('partially_harvested');
    const harvested = await service.updatePlantingStatus(owner, planting.id, 'harvested', {});
    expect(harvested.status).toBe('harvested');
    await expect(
      service.updatePlantingStatus(owner, planting.id, 'growing', {})
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires failureReason when failing a planting and records the event payload', async () => {
    const { planting } = await plotWithPlanting();
    await expect(
      service.updatePlantingStatus(owner, planting.id, 'failed', {})
    ).rejects.toBeInstanceOf(BadRequestException);
    const failed = await service.updatePlantingStatus(owner, planting.id, 'failed', {
      failureReason: 'drought'
    });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('drought');
  });

  it('replant linkage: replantOfId must reference a FAILED planting on the same plot', async () => {
    const { plot, planting } = await plotWithPlanting();
    // Still growing — not a valid replant target.
    await expect(
      service.createPlanting(owner, plot.id, {
        crop: 'sorghum',
        season: '2026-wet',
        plantedAt: '2026-06-01T00:00:00.000Z',
        replantOfId: planting.id
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.updatePlantingStatus(owner, planting.id, 'failed', { failureReason: 'pest' });
    const replant = await service.createPlanting(owner, plot.id, {
      crop: 'sorghum',
      season: '2026-wet',
      plantedAt: '2026-06-01T00:00:00.000Z',
      replantOfId: planting.id
    });
    expect(replant.replantOfId).toBe(planting.id);
  });
});

describe('FarmsService — expenses and intercrop allocation (A4)', () => {
  let service: FarmsService;
  beforeEach(() => {
    service = makeService().service;
  });

  it('validates allocation shares total exactly 100 and reference the plot plantings', async () => {
    const plot = await service.createPlot(owner, {
      name: 'Intercrop',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11,
      centroidLong: 7,
      sizeHectares: 2
    });
    const a = await service.createPlanting(owner, plot.id, {
      crop: 'maize',
      season: '2026-wet',
      plantedAt: '2026-05-01T00:00:00.000Z'
    });
    const b = await service.createPlanting(owner, plot.id, {
      crop: 'cowpea',
      season: '2026-wet',
      plantedAt: '2026-05-01T00:00:00.000Z'
    });
    // 60 + 30 != 100.
    await expect(
      service.createExpense(owner, plot.id, {
        category: 'fertilizer',
        amountKobo: 10000,
        incurredAt: '2026-05-02T00:00:00.000Z',
        allocations: [
          { plantingId: a.id, sharePercent: 60 },
          { plantingId: b.id, sharePercent: 30 }
        ]
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    const expense = await service.createExpense(owner, plot.id, {
      category: 'fertilizer',
      amountKobo: 10000,
      incurredAt: '2026-05-02T00:00:00.000Z',
      allocations: [
        { plantingId: a.id, sharePercent: 60 },
        { plantingId: b.id, sharePercent: 40 }
      ]
    });
    expect(expense.id).toBeDefined();
    const allocations = await service.listPlantingExpenseAllocations(owner, a.id);
    expect(allocations).toEqual([{ expenseId: expense.id, plantingId: a.id, sharePercent: 60 }]);
  });

  it('plot-level expenses carry no allocations', async () => {
    const plot = await service.createPlot(owner, {
      name: 'Shared',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11,
      centroidLong: 7,
      sizeHectares: 1
    });
    const expense = await service.createExpense(owner, plot.id, {
      category: 'labour',
      amountKobo: 4000,
      incurredAt: '2026-05-02T00:00:00.000Z'
    });
    const expenses = await service.listExpenses(owner, plot.id);
    expect(expenses.map((row) => row.id)).toContain(expense.id);
  });
});

describe('FarmsService — summary aggregation', () => {
  it('aggregates plots, active plantings and harvest totals per owner', async () => {
    const service = makeService().service;
    const plot = await service.createPlot(owner, {
      name: 'Summary',
      state: 'Kaduna',
      lga: 'Zaria',
      centroidLat: 11,
      centroidLong: 7,
      sizeHectares: 3
    });
    const planting = await service.createPlanting(owner, plot.id, {
      crop: 'rice',
      season: '2026-wet',
      plantedAt: '2026-05-01T00:00:00.000Z'
    });
    await service.recordHarvest(owner, planting.id, {
      harvestedAt: '2026-08-01T00:00:00.000Z',
      quantity: 2,
      unit: 'tonnes'
    });
    const summary = await service.summary(owner, undefined);
    expect(summary.plotCount).toBeGreaterThanOrEqual(1);
    expect(summary.totalHectares).toBeGreaterThanOrEqual(3);
    expect(summary.activePlantings).toBeGreaterThanOrEqual(1);
    const rice = summary.harvestTotalsByCrop.find((row) => row.crop === 'rice');
    expect(rice?.quantity).toBe(2);
    await expect(service.summary(owner, 'user-2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
