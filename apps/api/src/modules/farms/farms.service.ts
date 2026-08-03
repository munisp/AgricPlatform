import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import type {
  CropPlanting,
  FarmExpense,
  FarmPlot,
  FarmSummary,
  HarvestRecord,
  PlantingStatus,
  SoilType,
  User
} from '@agric-platform/shared';
import { isValidBoundaryGeojson, NIGERIAN_STATES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CROP_PLANTING_REPOSITORY,
  FARM_EXPENSE_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  HARVEST_RECORD_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CropPlantingRepository,
  FarmExpenseRepository,
  FarmPlotRepository,
  HarvestRecordRepository
} from '../../database/repositories/farms.repository.js';

export interface CreatePlotInput {
  name: string;
  state: string;
  lga: string;
  centroidLat: number;
  centroidLong: number;
  boundaryGeojson?: unknown;
  sizeHectares: number;
  soilType?: SoilType;
  clientId?: string;
}

export interface UpdatePlotInput {
  name?: string;
  state?: string;
  lga?: string;
  centroidLat?: number;
  centroidLong?: number;
  boundaryGeojson?: unknown;
  sizeHectares?: number;
  soilType?: SoilType;
}

export interface CreatePlantingInput {
  crop: string;
  variety?: string;
  season: string;
  plantedAt: string;
  expectedHarvestAt?: string;
  clientId?: string;
}

export interface RecordHarvestInput {
  harvestedAt: string;
  quantity: number;
  unit: HarvestRecord['unit'];
  qualityGrade?: HarvestRecord['qualityGrade'];
}

export interface CreateExpenseInput {
  category: FarmExpense['category'];
  amountKobo: number;
  incurredAt: string;
  note?: string;
}

/**
 * Planting status lifecycle: growing → harvested | failed; both terminal.
 * Recording a harvest flips the planting to 'harvested' at the service
 * layer.
 */
export const PLANTING_STATUS_TRANSITIONS: Record<PlantingStatus, readonly PlantingStatus[]> = {
  growing: ['harvested', 'failed'],
  harvested: [],
  failed: []
};

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for farm records');
  }
  return actor;
}

@Injectable()
export class FarmsService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(CROP_PLANTING_REPOSITORY) private readonly plantings: CropPlantingRepository,
    @Inject(HARVEST_RECORD_REPOSITORY) private readonly harvests: HarvestRecordRepository,
    @Inject(FARM_EXPENSE_REPOSITORY) private readonly expenses: FarmExpenseRepository
  ) {}

  private assertValidPlot(input: CreatePlotInput | UpdatePlotInput): void {
    if (input.state !== undefined && !NIGERIAN_STATES.includes(input.state as never)) {
      throw new BadRequestException(`Unknown Nigerian state '${input.state}'`);
    }
    if (input.centroidLat !== undefined && (input.centroidLat < -90 || input.centroidLat > 90)) {
      throw new BadRequestException('centroidLat must be between -90 and 90');
    }
    if (input.centroidLong !== undefined && (input.centroidLong < -180 || input.centroidLong > 180)) {
      throw new BadRequestException('centroidLong must be between -180 and 180');
    }
    if (input.sizeHectares !== undefined && input.sizeHectares <= 0) {
      throw new BadRequestException('sizeHectares must be greater than zero');
    }
    if (input.boundaryGeojson !== undefined && !isValidBoundaryGeojson(input.boundaryGeojson)) {
      throw new BadRequestException(
        'boundaryGeojson must be a GeoJSON Polygon or MultiPolygon geometry'
      );
    }
  }

  /** Loads a plot and asserts the actor may see it (owner or admin). */
  private async assertPlotAccess(actor: User | null, plotId: string): Promise<FarmPlot> {
    const plot = await this.plots.getById(plotId);
    assertSelfOrAdmin(actor, plot.ownerUserId);
    return plot;
  }

  /* ------------------------------- plots ------------------------------- */

  async createPlot(actor: User | null, input: CreatePlotInput): Promise<FarmPlot> {
    const owner = requireActor(actor);
    this.assertValidPlot(input);
    const now = new Date().toISOString();
    const plot: FarmPlot = {
      id: newId('plot'),
      ownerUserId: owner.id,
      name: input.name,
      state: input.state,
      lga: input.lga,
      centroidLat: input.centroidLat,
      centroidLong: input.centroidLong,
      boundaryGeojson: input.boundaryGeojson,
      sizeHectares: input.sizeHectares,
      soilType: input.soilType,
      createdAt: now,
      updatedAt: now,
      version: 1,
      clientId: input.clientId
    };
    const created = await this.plots.create(plot);
    await this.audit.record({
      actorId: owner.id,
      action: 'farms.plot_created',
      entityType: 'farm_plot',
      entityId: created.id,
      metadata: { state: created.state, lga: created.lga, sizeHectares: created.sizeHectares }
    });
    await this.events.publish(
      'farms.plot.created',
      { plotId: created.id, ownerUserId: owner.id, state: created.state },
      owner.id
    );
    return created;
  }

  /**
   * Owner-scoped listing (returns.service listReturns pattern): admins may
   * filter by any owner or see all; everyone else is pinned to themselves.
   */
  async listPlots(
    actor: User | null,
    filter: { ownerUserId?: string; state?: string } = {}
  ): Promise<FarmPlot[]> {
    const caller = requireActor(actor);
    if (caller.roles.includes('admin')) {
      return this.plots.find(filter);
    }
    if (filter.ownerUserId && filter.ownerUserId !== caller.id) {
      throw new ForbiddenException('You may only list your own farm plots');
    }
    return this.plots.find({ ...filter, ownerUserId: caller.id });
  }

  async getPlot(actor: User | null, id: string): Promise<FarmPlot> {
    return this.assertPlotAccess(actor, id);
  }

  async updatePlot(actor: User | null, id: string, patch: UpdatePlotInput): Promise<FarmPlot> {
    const plot = await this.assertPlotAccess(actor, id);
    this.assertValidPlot(patch);
    const updated = await this.plots.update(id, {
      ...patch,
      updatedAt: new Date().toISOString(),
      version: plot.version + 1
    });
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.plot_updated',
      entityType: 'farm_plot',
      entityId: id,
      metadata: { fields: Object.keys(patch), version: updated.version }
    });
    await this.events.publish(
      'farms.plot.updated',
      { plotId: id, ownerUserId: plot.ownerUserId, version: updated.version },
      actor!.id
    );
    return updated;
  }

  /** Owner-or-admin delete; child plantings/harvests/expenses go with it. */
  async removePlot(actor: User | null, id: string): Promise<{ removed: boolean }> {
    const plot = await this.assertPlotAccess(actor, id);
    const plotPlantings = await this.plantings.find({ plotId: id });
    for (const planting of plotPlantings) {
      const plantingHarvests = await this.harvests.find({ plantingId: planting.id });
      for (const harvest of plantingHarvests) {
        await this.harvests.remove(harvest.id);
      }
      await this.plantings.remove(planting.id);
    }
    const plotExpenses = await this.expenses.find({ plotId: id });
    for (const expense of plotExpenses) {
      await this.expenses.remove(expense.id);
    }
    const removed = await this.plots.remove(id);
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.plot_removed',
      entityType: 'farm_plot',
      entityId: id,
      metadata: { ownerUserId: plot.ownerUserId, removed }
    });
    await this.events.publish(
      'farms.plot.removed',
      { plotId: id, ownerUserId: plot.ownerUserId },
      actor!.id
    );
    return { removed };
  }

  /* ----------------------------- plantings ----------------------------- */

  async createPlanting(
    actor: User | null,
    plotId: string,
    input: CreatePlantingInput
  ): Promise<CropPlanting> {
    const plot = await this.assertPlotAccess(actor, plotId);
    const now = new Date().toISOString();
    const planting: CropPlanting = {
      id: newId('planting'),
      plotId: plot.id,
      crop: input.crop,
      variety: input.variety,
      season: input.season,
      plantedAt: input.plantedAt,
      expectedHarvestAt: input.expectedHarvestAt,
      status: 'growing',
      createdAt: now,
      updatedAt: now,
      version: 1,
      clientId: input.clientId
    };
    const created = await this.plantings.create(planting);
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.planting_created',
      entityType: 'crop_planting',
      entityId: created.id,
      metadata: { plotId: plot.id, crop: created.crop, season: created.season }
    });
    await this.events.publish(
      'farms.planting.created',
      { plantingId: created.id, plotId: plot.id, crop: created.crop },
      actor!.id
    );
    return created;
  }

  async listPlantings(actor: User | null, plotId: string): Promise<CropPlanting[]> {
    await this.assertPlotAccess(actor, plotId);
    return this.plantings.find({ plotId });
  }

  /** Owner-or-admin status transition following PLANTING_STATUS_TRANSITIONS. */
  async updatePlantingStatus(
    actor: User | null,
    plantingId: string,
    status: PlantingStatus
  ): Promise<CropPlanting> {
    const planting = await this.plantings.getById(plantingId);
    await this.assertPlotAccess(actor, planting.plotId);
    if (planting.status === status) {
      return planting; // idempotent replay of a retry
    }
    const allowed = PLANTING_STATUS_TRANSITIONS[planting.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Invalid planting status transition from '${planting.status}' to '${status}'`
      );
    }
    const updated = await this.plantings.update(plantingId, {
      status,
      updatedAt: new Date().toISOString(),
      version: planting.version + 1
    });
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.planting_status_changed',
      entityType: 'crop_planting',
      entityId: plantingId,
      metadata: { from: planting.status, to: status }
    });
    await this.events.publish(
      'farms.planting.status_changed',
      { plantingId, plotId: planting.plotId, from: planting.status, to: status },
      actor!.id
    );
    return updated;
  }

  /* ------------------------------ harvests ----------------------------- */

  /**
   * Records a harvest against a planting and flips a growing planting to
   * 'harvested' — the planting → harvest lifecycle. Failed plantings
   * cannot be harvested.
   */
  async recordHarvest(
    actor: User | null,
    plantingId: string,
    input: RecordHarvestInput
  ): Promise<HarvestRecord> {
    const planting = await this.plantings.getById(plantingId);
    await this.assertPlotAccess(actor, planting.plotId);
    if (planting.status === 'failed') {
      throw new BadRequestException(`Planting '${plantingId}' failed; it cannot be harvested`);
    }
    if (input.quantity < 0) {
      throw new BadRequestException('quantity must not be negative');
    }
    const harvest: HarvestRecord = {
      id: newId('harvest'),
      plantingId: planting.id,
      harvestedAt: input.harvestedAt,
      quantity: input.quantity,
      unit: input.unit,
      qualityGrade: input.qualityGrade,
      createdAt: new Date().toISOString()
    };
    const created = await this.harvests.create(harvest);
    if (planting.status === 'growing') {
      await this.plantings.update(planting.id, {
        status: 'harvested',
        updatedAt: new Date().toISOString(),
        version: planting.version + 1
      });
    }
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.harvest_recorded',
      entityType: 'harvest_record',
      entityId: created.id,
      metadata: {
        plantingId: planting.id,
        quantity: created.quantity,
        unit: created.unit
      }
    });
    await this.events.publish(
      'farms.harvest.recorded',
      {
        harvestId: created.id,
        plantingId: planting.id,
        plotId: planting.plotId,
        quantity: created.quantity,
        unit: created.unit
      },
      actor!.id
    );
    return created;
  }

  async listHarvests(actor: User | null, plantingId: string): Promise<HarvestRecord[]> {
    const planting = await this.plantings.getById(plantingId);
    await this.assertPlotAccess(actor, planting.plotId);
    return this.harvests.find({ plantingId });
  }

  /* ------------------------------ expenses ----------------------------- */

  async createExpense(
    actor: User | null,
    plotId: string,
    input: CreateExpenseInput
  ): Promise<FarmExpense> {
    const plot = await this.assertPlotAccess(actor, plotId);
    if (input.amountKobo < 0 || !Number.isInteger(input.amountKobo)) {
      throw new BadRequestException('amountKobo must be a non-negative integer (kobo)');
    }
    const expense: FarmExpense = {
      id: newId('expense'),
      plotId: plot.id,
      category: input.category,
      amountKobo: input.amountKobo,
      incurredAt: input.incurredAt,
      note: input.note,
      createdAt: new Date().toISOString()
    };
    const created = await this.expenses.create(expense);
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.expense_recorded',
      entityType: 'farm_expense',
      entityId: created.id,
      metadata: { plotId: plot.id, category: created.category, amountKobo: created.amountKobo }
    });
    await this.events.publish(
      'farms.expense.recorded',
      { expenseId: created.id, plotId: plot.id, amountKobo: created.amountKobo },
      actor!.id
    );
    return created;
  }

  async listExpenses(actor: User | null, plotId: string): Promise<FarmExpense[]> {
    await this.assertPlotAccess(actor, plotId);
    return this.expenses.find({ plotId });
  }

  /* ------------------------------ summary ------------------------------ */

  /** Per-owner aggregates; non-admins can only ever summarise themselves. */
  async summary(actor: User | null, ownerUserId?: string): Promise<FarmSummary> {
    const caller = requireActor(actor);
    if (!caller.roles.includes('admin') && ownerUserId && ownerUserId !== caller.id) {
      throw new ForbiddenException('You may only view your own farm summary');
    }
    const ownerId = caller.roles.includes('admin') ? (ownerUserId ?? caller.id) : caller.id;
    const ownerPlots = await this.plots.find({ ownerUserId: ownerId });
    const harvestByCrop = new Map<string, { totalQuantity: number; harvestCount: number }>();
    let activePlantings = 0;
    let totalExpensesKobo = 0;
    for (const plot of ownerPlots) {
      const plotPlantings = await this.plantings.find({ plotId: plot.id });
      for (const planting of plotPlantings) {
        if (planting.status === 'growing') {
          activePlantings += 1;
        }
        const plantingHarvests = await this.harvests.find({ plantingId: planting.id });
        for (const harvest of plantingHarvests) {
          const aggregate = harvestByCrop.get(planting.crop) ?? {
            totalQuantity: 0,
            harvestCount: 0
          };
          aggregate.totalQuantity += harvest.quantity;
          aggregate.harvestCount += 1;
          harvestByCrop.set(planting.crop, aggregate);
        }
      }
      const plotExpenses = await this.expenses.find({ plotId: plot.id });
      for (const expense of plotExpenses) {
        totalExpensesKobo += expense.amountKobo;
      }
    }
    return {
      ownerUserId: ownerId,
      plotCount: ownerPlots.length,
      totalHectares: ownerPlots.reduce((total, plot) => total + plot.sizeHectares, 0),
      activePlantings,
      harvestByCrop: [...harvestByCrop.entries()]
        .map(([crop, aggregate]) => ({ crop, ...aggregate }))
        .sort((a, b) => a.crop.localeCompare(b.crop)),
      totalExpensesKobo
    };
  }
}
