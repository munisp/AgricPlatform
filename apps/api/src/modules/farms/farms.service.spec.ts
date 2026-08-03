import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCropPlantingRepository,
  createInMemoryFarmExpenseRepository,
  createInMemoryFarmPlotRepository,
  createInMemoryHarvestRecordRepository
} from '../../database/repositories/farms.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { FarmsService } from './farms.service.js';

type UserRef = Pick<User, 'id' | 'roles'>;
const asUser = (ref: UserRef): User => ({
  phone: '+2348000000000',
  fullName: 'Spec User',
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...ref
});

const farmer = asUser({ id: 'farmer-1', roles: ['farmer'] });
const otherFarmer = asUser({ id: 'farmer-2', roles: ['farmer'] });
const admin = asUser({ id: 'admin-1', roles: ['admin'] });

const plotInput = {
  name: 'Zaria North Plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 11.08,
  centroidLong: 7.72,
  sizeHectares: 2.5
};

const boundary = {
  type: 'Polygon',
  coordinates: [
    [
      [7.72, 11.08],
      [7.73, 11.08],
      [7.73, 11.09],
      [7.72, 11.08]
    ]
  ]
};

const plantingInput = {
  crop: 'Maize',
  variety: 'Oba Super 2',
  season: '2025-wet',
  plantedAt: '2025-05-15T00:00:00.000Z',
  expectedHarvestAt: '2025-09-15T00:00:00.000Z'
};

describe('FarmsService', () => {
  let plots: ReturnType<typeof createInMemoryFarmPlotRepository>;
  let plantings: ReturnType<typeof createInMemoryCropPlantingRepository>;
  let harvests: ReturnType<typeof createInMemoryHarvestRecordRepository>;
  let expenses: ReturnType<typeof createInMemoryFarmExpenseRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let events: DomainEventsService;
  let service: FarmsService;

  beforeEach(() => {
    plots = createInMemoryFarmPlotRepository();
    plantings = createInMemoryCropPlantingRepository();
    harvests = createInMemoryHarvestRecordRepository();
    expenses = createInMemoryFarmExpenseRepository();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    events = new DomainEventsService(createInMemoryOutboxRepository());
    service = new FarmsService(
      audit as never,
      events,
      plots,
      plantings,
      harvests,
      expenses
    );
  });

  /* ------------------------------- plots ------------------------------- */

  it('creates a plot for the caller with sync metadata, audit and event', async () => {
    const plot = await service.createPlot(farmer, { ...plotInput, boundaryGeojson: boundary });
    expect(plot.id).toMatch(/^plot-/);
    expect(plot.ownerUserId).toBe('farmer-1');
    expect(plot.version).toBe(1);
    expect(plot.boundaryGeojson).toEqual(boundary);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'farms.plot_created', entityId: plot.id })
    );
    const outbox = await events.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].name).toBe('farms.plot.created');
  });

  it('rejects plots with an unknown state, bad centroid or invalid boundary', async () => {
    await expect(service.createPlot(farmer, { ...plotInput, state: 'Atlantis' })).rejects.toThrow(
      /Unknown Nigerian state/
    );
    await expect(service.createPlot(farmer, { ...plotInput, centroidLat: 95 })).rejects.toThrow(
      /centroidLat/
    );
    await expect(
      service.createPlot(farmer, { ...plotInput, boundaryGeojson: { type: 'Point', coordinates: [1, 2] } })
    ).rejects.toThrow(/GeoJSON/);
    await expect(service.createPlot(farmer, { ...plotInput, sizeHectares: 0 })).rejects.toThrow(
      /sizeHectares/
    );
  });

  it('requires authentication for plot creation', async () => {
    await expect(service.createPlot(null, plotInput)).rejects.toThrow(/Authentication required/);
  });

  it('scopes plot listing to the owner; admins can list all or filter', async () => {
    await service.createPlot(farmer, plotInput);
    await service.createPlot(otherFarmer, { ...plotInput, name: 'Kano Plot', state: 'Kano' });
    expect(await service.listPlots(farmer)).toHaveLength(1);
    expect(await service.listPlots(admin)).toHaveLength(2);
    expect(await service.listPlots(admin, { ownerUserId: 'farmer-2' })).toHaveLength(1);
    await expect(service.listPlots(farmer, { ownerUserId: 'farmer-2' })).rejects.toThrow(
      /your own farm plots/
    );
  });

  it('restricts plot detail and updates to owner or admin', async () => {
    const plot = await service.createPlot(farmer, plotInput);
    await expect(service.getPlot(otherFarmer, plot.id)).rejects.toThrow(/your own records/);
    expect(await service.getPlot(admin, plot.id)).toEqual(plot);
    await expect(service.updatePlot(otherFarmer, plot.id, { name: 'x' })).rejects.toThrow(
      /your own records/
    );
    const updated = await service.updatePlot(farmer, plot.id, { name: 'Renamed', sizeHectares: 3 });
    expect(updated.name).toBe('Renamed');
    expect(updated.version).toBe(2);
  });

  it('removes a plot with its plantings, harvests and expenses', async () => {
    const plot = await service.createPlot(farmer, plotInput);
    const planting = await service.createPlanting(farmer, plot.id, plantingInput);
    await service.recordHarvest(farmer, planting.id, {
      harvestedAt: '2025-09-20T00:00:00.000Z',
      quantity: 40,
      unit: 'bags'
    });
    await service.createExpense(farmer, plot.id, {
      category: 'seeds',
      amountKobo: 150_000,
      incurredAt: '2025-05-10T00:00:00.000Z'
    });
    const result = await service.removePlot(farmer, plot.id);
    expect(result.removed).toBe(true);
    expect(await plantings.find({ plotId: plot.id })).toHaveLength(0);
    expect(await harvests.find({ plantingId: planting.id })).toHaveLength(0);
    expect(await expenses.find({ plotId: plot.id })).toHaveLength(0);
    await expect(service.removePlot(farmer, plot.id)).rejects.toThrow(/not found/);
  });

  /* ----------------------------- plantings ----------------------------- */

  it('creates plantings only on plots the actor can access', async () => {
    const plot = await service.createPlot(farmer, plotInput);
    await expect(service.createPlanting(otherFarmer, plot.id, plantingInput)).rejects.toThrow(
      /your own records/
    );
    const planting = await service.createPlanting(farmer, plot.id, plantingInput);
    expect(planting.status).toBe('growing');
    expect(planting.version).toBe(1);
    expect(await service.listPlantings(farmer, plot.id)).toHaveLength(1);
  });

  it('enforces the planting status lifecycle with idempotent replays', async () => {
    const plot = await service.createPlot(farmer, plotInput);
    const planting = await service.createPlanting(farmer, plot.id, plantingInput);
    const failed = await service.updatePlantingStatus(farmer, planting.id, 'failed');
    expect(failed.status).toBe('failed');
    // Replay of the same transition is a no-op.
    expect(await service.updatePlantingStatus(farmer, planting.id, 'failed')).toEqual(failed);
    await expect(service.updatePlantingStatus(farmer, planting.id, 'growing')).rejects.toThrow(
      /Invalid planting status transition/
    );
    await expect(
      service.recordHarvest(farmer, planting.id, {
        harvestedAt: '2025-09-20T00:00:00.000Z',
        quantity: 10,
        unit: 'kg'
      })
    ).rejects.toThrow(/cannot be harvested/);
  });

  /* ------------------------------ harvests ----------------------------- */

  it('records a harvest and flips the planting to harvested', async () => {
    const plot = await service.createPlot(farmer, plotInput);
    const planting = await service.createPlanting(farmer, plot.id, plantingInput);
    const harvest = await service.recordHarvest(farmer, planting.id, {
      harvestedAt: '2025-09-20T00:00:00.000Z',
      quantity: 40,
      unit: 'bags',
      qualityGrade: 'A'
    });
    expect(harvest.plantingId).toBe(planting.id);
    expect((await plantings.getById(planting.id)).status).toBe('harvested');
    expect(await service.listHarvests(farmer, planting.id)).toHaveLength(1);
    await expect(service.listHarvests(otherFarmer, planting.id)).rejects.toThrow(
      /your own records/
    );
    await expect(
      service.recordHarvest(farmer, planting.id, {
        harvestedAt: '2025-09-21T00:00:00.000Z',
        quantity: -1,
        unit: 'bags'
      })
    ).rejects.toThrow(/quantity/);
  });

  /* ------------------------------ expenses ----------------------------- */

  it('records integer-kobo expenses and rejects invalid amounts', async () => {
    const plot = await service.createPlot(farmer, plotInput);
    await expect(
      service.createExpense(farmer, plot.id, {
        category: 'labour',
        amountKobo: 10.5,
        incurredAt: '2025-06-01T00:00:00.000Z'
      })
    ).rejects.toThrow(/kobo/);
    const expense = await service.createExpense(farmer, plot.id, {
      category: 'fertilizer',
      amountKobo: 750_000,
      incurredAt: '2025-06-01T00:00:00.000Z',
      note: 'NPK 20-10-10'
    });
    expect(expense.amountKobo).toBe(750_000);
    expect(await service.listExpenses(farmer, plot.id)).toHaveLength(1);
    await expect(service.listExpenses(otherFarmer, plot.id)).rejects.toThrow(/your own records/);
  });

  /* ------------------------------ summary ------------------------------ */

  it('aggregates per-owner summary across plots', async () => {
    const plotA = await service.createPlot(farmer, plotInput);
    const plotB = await service.createPlot(farmer, { ...plotInput, name: 'Second', sizeHectares: 1.5 });
    await service.createPlot(otherFarmer, { ...plotInput, name: 'Not mine' });
    const maize = await service.createPlanting(farmer, plotA.id, plantingInput);
    await service.createPlanting(farmer, plotB.id, { ...plantingInput, crop: 'Cassava' });
    await service.recordHarvest(farmer, maize.id, {
      harvestedAt: '2025-09-20T00:00:00.000Z',
      quantity: 40,
      unit: 'bags'
    });
    await service.recordHarvest(farmer, maize.id, {
      harvestedAt: '2025-09-22T00:00:00.000Z',
      quantity: 10,
      unit: 'bags'
    });
    await service.createExpense(farmer, plotA.id, {
      category: 'seeds',
      amountKobo: 200_000,
      incurredAt: '2025-05-10T00:00:00.000Z'
    });
    const summary = await service.summary(farmer);
    expect(summary.ownerUserId).toBe('farmer-1');
    expect(summary.plotCount).toBe(2);
    expect(summary.totalHectares).toBe(4);
    expect(summary.activePlantings).toBe(1); // cassava still growing
    expect(summary.harvestByCrop).toEqual([{ crop: 'Maize', totalQuantity: 50, harvestCount: 2 }]);
    expect(summary.totalExpensesKobo).toBe(200_000);
  });

  it('scopes summary to the caller unless admin', async () => {
    await service.createPlot(farmer, plotInput);
    await expect(service.summary(farmer, 'farmer-2')).rejects.toThrow(/your own farm summary/);
    const adminView = await service.summary(admin, 'farmer-1');
    expect(adminView.ownerUserId).toBe('farmer-1');
    expect(adminView.plotCount).toBe(1);
    expect((await service.summary(farmer, 'farmer-1')).ownerUserId).toBe('farmer-1');
  });
});
