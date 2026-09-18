import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCropPlantingRepository,
  createInMemoryFarmExpenseAllocationRepository,
  createInMemoryFarmExpenseRepository,
  createInMemoryFarmPlotRepository,
  createInMemoryHarvestRecordRepository
} from '../../database/repositories/farms.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { FarmsService } from './farms.service.js';

/**
 * W2-FP4 planting-lifecycle specs (dim04 A2/A3/A4 + the V-03 failure-event
 * contract): replant linkage, staggered-harvest status, intercrop expense
 * allocation, and the crop-failure event payload.
 */

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

const plotInput = {
  name: 'Zaria North Plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 11.08,
  centroidLong: 7.72,
  sizeHectares: 2.5
};

const plantingInput = {
  crop: 'Maize',
  season: '2025-wet',
  plantedAt: '2025-05-15T00:00:00.000Z'
};

function makeService(withAllocations = true) {
  const plots = createInMemoryFarmPlotRepository();
  const plantings = createInMemoryCropPlantingRepository();
  const harvests = createInMemoryHarvestRecordRepository();
  const expenses = createInMemoryFarmExpenseRepository();
  const allocations = createInMemoryFarmExpenseAllocationRepository();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new FarmsService(
    audit as never,
    events,
    plots,
    plantings,
    harvests,
    expenses,
    undefined,
    undefined,
    withAllocations ? allocations : undefined
  );
  return { service, plots, plantings, harvests, expenses, allocations, audit, events };
}

const harvest = (quantity: number, day = '2025-09-20') => ({
  harvestedAt: `${day}T00:00:00.000Z`,
  quantity,
  unit: 'kg' as const
});

/* ------------------------- A2: replant linkage ------------------------- */

describe('A2 — replant linkage', () => {
  it('links a replant to its failed predecessor on the same plot', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const first = await h.service.createPlanting(farmer, plot.id, plantingInput);
    await h.service.updatePlantingStatus(farmer, first.id, 'failed', { failureReason: 'flood' });

    const replant = await h.service.createPlanting(farmer, plot.id, {
      ...plantingInput,
      season: '2025-late',
      replantOfId: first.id
    });
    expect(replant.replantOfId).toBe(first.id);
    expect(replant.status).toBe('growing');
    // History is traceable from storage, and the event/audit carry the link.
    expect((await h.plantings.getById(replant.id)).replantOfId).toBe(first.id);
    const outbox = await h.events.listOutbox();
    const created = outbox.find(
      (e) =>
        e.name === 'farms.planting.created' &&
        (e.payload as Record<string, unknown>).plantingId === replant.id
    );
    expect(created?.payload).toMatchObject({ replantOfId: first.id });
  });

  it('rejects replants of plantings that are not failed', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const growing = await h.service.createPlanting(farmer, plot.id, plantingInput);
    await expect(
      h.service.createPlanting(farmer, plot.id, { ...plantingInput, replantOfId: growing.id })
    ).rejects.toThrow(/not 'failed'/);
  });

  it('rejects replants pointing at another plot or a nonexistent planting (fail closed)', async () => {
    const h = makeService();
    const plotA = await h.service.createPlot(farmer, plotInput);
    const plotB = await h.service.createPlot(farmer, { ...plotInput, name: 'Second' });
    const failedElsewhere = await h.service.createPlanting(farmer, plotB.id, plantingInput);
    await h.service.updatePlantingStatus(farmer, failedElsewhere.id, 'failed', {
      failureReason: 'pests'
    });
    await expect(
      h.service.createPlanting(farmer, plotA.id, { ...plantingInput, replantOfId: failedElsewhere.id })
    ).rejects.toThrow(/different plot/);
    await expect(
      h.service.createPlanting(farmer, plotA.id, { ...plantingInput, replantOfId: 'planting-ghost' })
    ).rejects.toThrow(/not found/);
  });
});

/* --------------------- A3: staggered harvest status --------------------- */

describe('A3 — partially_harvested lifecycle', () => {
  it('accumulates staggered picks while the planting stays active, then closes explicitly', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const planting = await h.service.createPlanting(farmer, plot.id, { ...plantingInput, crop: 'Tomato' });

    await h.service.recordHarvest(farmer, planting.id, harvest(30, '2025-09-01'));
    expect((await h.plantings.getById(planting.id)).status).toBe('partially_harvested');
    // The first pick announces the state change like a manual transition.
    const outbox = await h.events.listOutbox();
    expect(
      outbox.some(
        (e) =>
          e.name === 'farms.planting.status_changed' &&
          (e.payload as Record<string, unknown>).to === 'partially_harvested' &&
          (e.payload as Record<string, unknown>).plantingId === planting.id
      )
    ).toBe(true);

    // Picks 2–4 accumulate — the planting is NOT terminally harvested.
    await h.service.recordHarvest(farmer, planting.id, harvest(25, '2025-09-08'));
    await h.service.recordHarvest(farmer, planting.id, harvest(20, '2025-09-15'));
    expect(await h.service.listHarvests(farmer, planting.id)).toHaveLength(3);
    expect((await h.plantings.getById(planting.id)).status).toBe('partially_harvested');

    // Explicit close; afterwards the planting is terminal.
    const closed = await h.service.updatePlantingStatus(farmer, planting.id, 'harvested');
    expect(closed.status).toBe('harvested');
    await expect(h.service.recordHarvest(farmer, planting.id, harvest(10))).rejects.toThrow(
      /fully harvested/
    );
  });

  it('keeps direct growing → harvested and partially_harvested → failed transitions legal', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const onePick = await h.service.createPlanting(farmer, plot.id, plantingInput);
    const noPicks = await h.service.createPlanting(farmer, plot.id, {
      ...plantingInput,
      crop: 'Cassava'
    });

    // Manual close without any pick remains possible (e.g. sold standing).
    expect((await h.service.updatePlantingStatus(farmer, noPicks.id, 'harvested')).status).toBe(
      'harvested'
    );
    await h.service.recordHarvest(farmer, onePick.id, harvest(10));
    // A partially-harvested crop can still fail (late blight wipes the rest).
    const failed = await h.service.updatePlantingStatus(farmer, onePick.id, 'failed', {
      failureReason: 'disease'
    });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('disease');
  });
});

/* ------------------- A4: intercrop expense allocation ------------------- */

describe('A4 — intercrop expense allocation', () => {
  async function intercroppedPlot(h: ReturnType<typeof makeService>) {
    const plot = await h.service.createPlot(farmer, plotInput);
    const maize = await h.service.createPlanting(farmer, plot.id, plantingInput);
    const cowpea = await h.service.createPlanting(farmer, plot.id, {
      ...plantingInput,
      crop: 'Cowpea'
    });
    return { plot, maize, cowpea };
  }

  it('records explicit shares and returns them on expense reads', async () => {
    const h = makeService();
    const { plot, maize, cowpea } = await intercroppedPlot(h);
    const expense = await h.service.createExpense(farmer, plot.id, {
      category: 'fertilizer',
      amountKobo: 500_000,
      incurredAt: '2025-06-01T00:00:00.000Z',
      allocations: [
        { plantingId: maize.id, sharePercent: 70 },
        { plantingId: cowpea.id, sharePercent: 30 }
      ]
    });
    expect(expense.allocations).toHaveLength(2);

    const listed = await h.service.listExpenses(farmer, plot.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].allocations).toEqual([
      { plantingId: maize.id, sharePercent: 70 },
      { plantingId: cowpea.id, sharePercent: 30 }
    ]);
    const rows = await h.allocations.listForPlanting(cowpea.id);
    expect(rows).toEqual([{ expenseId: expense.id, plantingId: cowpea.id, sharePercent: 30 }]);
  });

  it('rejects shares that do not total exactly 100, duplicates, and foreign plantings', async () => {
    const h = makeService();
    const { plot, maize, cowpea } = await intercroppedPlot(h);
    const base = {
      category: 'labour' as const,
      amountKobo: 100_000,
      incurredAt: '2025-06-01T00:00:00.000Z'
    };
    await expect(
      h.service.createExpense(farmer, plot.id, {
        ...base,
        allocations: [
          { plantingId: maize.id, sharePercent: 60 },
          { plantingId: cowpea.id, sharePercent: 30 }
        ]
      })
    ).rejects.toThrow(/sum to exactly 100/);
    await expect(
      h.service.createExpense(farmer, plot.id, {
        ...base,
        allocations: [
          { plantingId: maize.id, sharePercent: 60 },
          { plantingId: maize.id, sharePercent: 40 }
        ]
      })
    ).rejects.toThrow(/Duplicate allocation/);

    const otherPlot = await h.service.createPlot(farmer, { ...plotInput, name: 'Elsewhere' });
    const foreign = await h.service.createPlanting(farmer, otherPlot.id, plantingInput);
    await expect(
      h.service.createExpense(farmer, plot.id, {
        ...base,
        allocations: [
          { plantingId: maize.id, sharePercent: 50 },
          { plantingId: foreign.id, sharePercent: 50 }
        ]
      })
    ).rejects.toThrow(/different plot/);
  });

  it('defaults to plot-level (shared) when allocations are omitted — never silent full attribution', async () => {
    const h = makeService();
    const { plot } = await intercroppedPlot(h);
    const expense = await h.service.createExpense(farmer, plot.id, {
      category: 'irrigation',
      amountKobo: 80_000,
      incurredAt: '2025-06-01T00:00:00.000Z'
    });
    expect(expense.allocations).toBeUndefined();
    const listed = await h.service.listExpenses(farmer, plot.id);
    expect(listed[0].allocations).toBeUndefined();
  });

  it('fails closed when allocation persistence is not wired (no silent plot-level fallback)', async () => {
    const h = makeService(false);
    const plot = await h.service.createPlot(farmer, plotInput);
    const maize = await h.service.createPlanting(farmer, plot.id, plantingInput);
    await expect(
      h.service.createExpense(farmer, plot.id, {
        category: 'seeds',
        amountKobo: 50_000,
        incurredAt: '2025-06-01T00:00:00.000Z',
        allocations: [{ plantingId: maize.id, sharePercent: 100 }]
      })
    ).rejects.toThrow(/allocation persistence is not configured/);
    // And nothing was recorded.
    expect(await h.expenses.find({ plotId: plot.id })).toHaveLength(0);
  });
});

/* ----------------- V-03: failure event payload contract ----------------- */

describe('V-03 — farms.planting.status_changed (→ failed) event contract', () => {
  it('carries plantingId, plotId, ownerId, cropType, failureReason and occurredAt', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const planting = await h.service.createPlanting(farmer, plot.id, {
      ...plantingInput,
      crop: 'Sorghum'
    });
    const before = new Date().toISOString();
    await h.service.updatePlantingStatus(farmer, planting.id, 'failed', {
      failureReason: 'drought'
    });

    const outbox = await h.events.listOutbox();
    const event = outbox.find(
      (e) =>
        e.name === 'farms.planting.status_changed' &&
        (e.payload as Record<string, unknown>).to === 'failed'
    );
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({
      plantingId: planting.id,
      plotId: plot.id,
      ownerId: farmer.id, // the farmer identity for the loan subscriber
      cropType: 'Sorghum',
      failureReason: 'drought',
      from: 'growing',
      to: 'failed'
    });
    const occurredAt = (event!.payload as Record<string, unknown>).occurredAt as string;
    expect(typeof occurredAt).toBe('string');
    expect(occurredAt >= before).toBe(true);
    // The reason is also persisted on the planting row.
    expect((await h.plantings.getById(planting.id)).failureReason).toBe('drought');
  });

  it('requires a failureReason for the failed transition and rejects it elsewhere', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const planting = await h.service.createPlanting(farmer, plot.id, plantingInput);
    await expect(
      h.service.updatePlantingStatus(farmer, planting.id, 'failed', { failureReason: undefined })
    ).rejects.toThrow(/failureReason is required/);
    await expect(
      h.service.updatePlantingStatus(farmer, planting.id, 'harvested', { failureReason: 'other' })
    ).rejects.toThrow(/only applies to the failed transition/);
    // Nothing transitioned.
    expect((await h.plantings.getById(planting.id)).status).toBe('growing');
  });

  it('keeps the legacy payload shape for non-failure transitions', async () => {
    const h = makeService();
    const plot = await h.service.createPlot(farmer, plotInput);
    const planting = await h.service.createPlanting(farmer, plot.id, plantingInput);
    await h.service.updatePlantingStatus(farmer, planting.id, 'harvested');
    const outbox = await h.events.listOutbox();
    const event = outbox.find((e) => e.name === 'farms.planting.status_changed');
    expect(event!.payload as Record<string, unknown>).toEqual({
      plantingId: planting.id,
      plotId: plot.id,
      from: 'growing',
      to: 'harvested'
    });
  });
});
