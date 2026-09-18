import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import type {
  CropPlanting,
  FarmExpense,
  FarmExpenseAllocation,
  FarmPlot,
  FarmSummary,
  HarvestRecord,
  PlantingFailureReason,
  PlantingStatus,
  SoilType,
  User
} from '@agric-platform/shared';
import {
  isValidBoundaryGeojson,
  NIGERIAN_STATES,
  PLANTING_FAILURE_REASONS,
  SOIL_TYPES
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CROP_PLANTING_REPOSITORY,
  ENTITY_VERSION_REPOSITORY,
  FARM_EXPENSE_ALLOCATION_REPOSITORY,
  FARM_EXPENSE_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  HARVEST_RECORD_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CropPlantingRepository,
  FarmExpenseAllocationRepository,
  FarmExpenseRepository,
  FarmPlotRepository,
  HarvestRecordRepository
} from '../../database/repositories/farms.repository.js';
import type { EntityVersionBump, EntityVersionRepository } from '../../database/repositories/sync.repository.js';
import type { SyncVersioningService } from '../sync/sync-versioning.service.js';
import { SyncVersionConflictError, type SyncPushItem } from '../sync/sync.types.js';

/** Sync protocol entity key for farm plots (docs/sync-protocol.md §2). */
export const SYNC_ENTITY_FARM_PLOT = 'farm_plot';

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
  /**
   * Replant linkage (A2): when set, this planting is the replant of a
   * FAILED predecessor ON THE SAME PLOT — validated fail-closed at create
   * time so failure → replant history stays traceable.
   */
  replantOfId?: string;
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
  /**
   * Intercrop allocation (A4): explicit per-planting percentage shares of
   * this expense. When supplied the shares must cover distinct plantings
   * ON THIS PLOT and sum to exactly 100. When omitted the expense is
   * PLOT-LEVEL — the documented default rule: shared across the plot, never
   * silently full-attributed to one crop.
   */
  allocations?: FarmExpenseAllocation[];
}

/**
 * Planting status lifecycle (v2, W2-FP4/A3):
 *   growing → partially_harvested | harvested | failed
 *   partially_harvested → harvested | failed
 *   harvested / failed are terminal.
 * Recording a harvest flips a growing planting to 'partially_harvested'
 * (NOT terminal 'harvested') at the service layer; the farmer closes the
 * season with an explicit partially_harvested → harvested transition, so
 * downstream "still growing" logic (advisory pulses, expected-harvest
 * windows) stays correct across staggered picks.
 */
export const PLANTING_STATUS_TRANSITIONS: Record<PlantingStatus, readonly PlantingStatus[]> = {
  growing: ['partially_harvested', 'harvested', 'failed'],
  partially_harvested: ['harvested', 'failed'],
  harvested: [],
  failed: []
};

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for farm records');
  }
  return actor;
}

/**
 * Strictly parses a sync upsert payload into plot fields (fail-closed: the
 * wire payload is untyped JSON, so every field is type-checked before it
 * touches the repository). Mirrors the REST CreatePlotDto validation; the
 * semantic checks live in assertValidPlot.
 */
export function parseSyncedPlotPayload(payload: Record<string, unknown> | undefined): CreatePlotInput {
  if (!payload || typeof payload !== 'object') {
    throw new BadRequestException('farm_plot upsert requires a payload');
  }
  const { name, state, lga, centroidLat, centroidLong, boundaryGeojson, sizeHectares, soilType, clientId } =
    payload;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new BadRequestException('name must be a non-empty string');
  }
  if (typeof state !== 'string' || state.trim().length === 0) {
    throw new BadRequestException('state must be a non-empty string');
  }
  if (typeof lga !== 'string' || lga.trim().length === 0) {
    throw new BadRequestException('lga must be a non-empty string');
  }
  if (typeof centroidLat !== 'number' || typeof centroidLong !== 'number') {
    throw new BadRequestException('centroidLat/centroidLong must be numbers');
  }
  if (typeof sizeHectares !== 'number') {
    throw new BadRequestException('sizeHectares must be a number');
  }
  if (soilType !== undefined && !SOIL_TYPES.includes(soilType as SoilType)) {
    throw new BadRequestException(`Unknown soil type '${String(soilType)}'`);
  }
  if (clientId !== undefined && typeof clientId !== 'string') {
    throw new BadRequestException('clientId must be a string when present');
  }
  return {
    name,
    state,
    lga,
    centroidLat,
    centroidLong,
    boundaryGeojson,
    sizeHectares,
    soilType: soilType as SoilType | undefined,
    clientId: clientId as string | undefined
  };
}

@Injectable()
export class FarmsService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(CROP_PLANTING_REPOSITORY) private readonly plantings: CropPlantingRepository,
    @Inject(HARVEST_RECORD_REPOSITORY) private readonly harvests: HarvestRecordRepository,
    @Inject(FARM_EXPENSE_REPOSITORY) private readonly expenses: FarmExpenseRepository,
    // W-SYNCWRITE: optional sync wiring — the version-bump hook makes REST
    // writes sync-visible; the version ledger CAS backs the sync push apply
    // path. Both are optional so existing unit constructions keep working.
    @Optional() private readonly syncVersioning?: SyncVersioningService,
    @Optional()
    @Inject(ENTITY_VERSION_REPOSITORY)
    private readonly entityVersions?: EntityVersionRepository,
    // W2-FP4 (A4): intercrop expense allocation ledger. Optional so bare
    // unit constructions keep working; supplying allocations without the
    // repo wired fails closed.
    @Optional()
    @Inject(FARM_EXPENSE_ALLOCATION_REPOSITORY)
    private readonly expenseAllocations?: FarmExpenseAllocationRepository
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

  /**
   * V-18/L-10 REST write discipline: the version-ledger row is CAS-claimed
   * atomically (against its current version, read immediately before the
   * claim) and the entity write runs only while the claim is held. A
   * concurrent sync push or REST write that moved the ledger fails the
   * claim → 409 Conflict instead of a silent source-row overwrite; a write
   * that throws rolls the claim back, so a REST write can never become
   * sync-invisible (the L-10 gap).
   */
  private async writePlotWithVersionClaim<T>(
    claim: EntityVersionBump,
    write: () => Promise<T>
  ): Promise<T> {
    const entityVersions = this.entityVersions!;
    const current = await entityVersions.current(claim.entity, claim.entityId);
    const claimed = await entityVersions.applyGuarded(
      { ...claim, expectedVersion: current?.version ?? 0 },
      write
    );
    if (claimed === null) {
      throw new ConflictException(
        `farm plot '${claim.entityId}' was modified concurrently — re-read and retry`
      );
    }
    return claimed.value;
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
    const created = this.entityVersions
      ? await this.writePlotWithVersionClaim(
          {
            entity: SYNC_ENTITY_FARM_PLOT,
            entityId: plot.id,
            ownerId: owner.id,
            updatedBy: owner.id,
            deleted: false
          },
          () => this.plots.create(plot)
        )
      : await this.plots.create(plot);
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
    if (!this.entityVersions) {
      await this.syncVersioning?.recordChange({
        entity: SYNC_ENTITY_FARM_PLOT,
        entityId: created.id,
        ownerId: owner.id,
        actorId: owner.id
      });
    }
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
    const write = (): Promise<FarmPlot> =>
      this.plots.update(id, {
        ...patch,
        updatedAt: new Date().toISOString(),
        version: plot.version + 1
      });
    const updated = this.entityVersions
      ? await this.writePlotWithVersionClaim(
          {
            entity: SYNC_ENTITY_FARM_PLOT,
            entityId: id,
            ownerId: plot.ownerUserId,
            updatedBy: actor!.id,
            deleted: false
          },
          write
        )
      : await write();
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
    if (!this.entityVersions) {
      await this.syncVersioning?.recordChange({
        entity: SYNC_ENTITY_FARM_PLOT,
        entityId: id,
        ownerId: plot.ownerUserId,
        actorId: actor!.id
      });
    }
    return updated;
  }

  /** Removes a plot with its child plantings/harvests/expenses. */
  private async deletePlotCascade(id: string): Promise<boolean> {
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
    return this.plots.remove(id);
  }

  /** Owner-or-admin delete; child plantings/harvests/expenses go with it. */
  async removePlot(actor: User | null, id: string): Promise<{ removed: boolean }> {
    const plot = await this.assertPlotAccess(actor, id);
    const removed = this.entityVersions
      ? await this.writePlotWithVersionClaim(
          {
            entity: SYNC_ENTITY_FARM_PLOT,
            entityId: id,
            ownerId: plot.ownerUserId,
            updatedBy: actor!.id,
            deleted: true
          },
          () => this.deletePlotCascade(id)
        )
      : await this.deletePlotCascade(id);
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
    if (!this.entityVersions) {
      await this.syncVersioning?.recordChange({
        entity: SYNC_ENTITY_FARM_PLOT,
        entityId: id,
        ownerId: plot.ownerUserId,
        actorId: actor!.id,
        deleted: true
      });
    }
    return { removed };
  }

  /* ------------------------ sync push apply (W-SYNCWRITE) ------------------------ */

  /**
   * Applies one validated sync push item for `farm_plot`
   * (docs/sync-protocol.md §4). The sync engine has already authenticated
   * the caller, enforced owner scoping and pre-checked the baseVersion CAS;
   * this method CLAIMS the sync.entity_versions row atomically (applyGuarded)
   * and performs the entity write only while the claim is held — a
   * concurrent push or REST write for the same record can never interleave
   * its write between our pre-check and our CAS (V-18). A lost claim throws
   * SyncVersionConflictError, which the sync engine maps to a per-item
   * `conflict` — the losing payload never touches the source row. Upserts
   * are full replacements (create with the client-stable entityId when the
   * record does not exist yet); deletes cascade like REST deletes and leave
   * a tombstone version row. Any other thrown error surfaces as a per-item
   * `error` result — never a silent write.
   */
  async applySyncedPlot(actor: User, item: SyncPushItem): Promise<number> {
    if (!this.entityVersions) {
      throw new Error('Sync version persistence is not configured for farm plots');
    }
    const entityVersions = this.entityVersions;
    const existing = await this.plots.findById(item.entityId);
    if (existing) {
      // Defence in depth on top of the sync engine's scope check.
      assertSelfOrAdmin(actor, existing.ownerUserId);
    } else {
      // V-63 defence in depth: with no live row, ownership comes from the
      // version ledger — refuse create-over-foreign-tombstone even if this
      // hook is ever invoked without the engine's scoping.
      const ledgerRow = await entityVersions.current(SYNC_ENTITY_FARM_PLOT, item.entityId);
      if (ledgerRow?.ownerId && ledgerRow.ownerId !== actor.id && !actor.roles.includes('admin')) {
        throw new ForbiddenException('This record id is owned by another user');
      }
    }

    if (item.op === 'delete') {
      const claimed = await entityVersions.applyGuarded(
        {
          entity: SYNC_ENTITY_FARM_PLOT,
          entityId: item.entityId,
          // The original owner keeps the tombstone in their sync scope even
          // when an admin performed the delete.
          ownerId: existing?.ownerUserId ?? actor.id,
          updatedBy: actor.id,
          deleted: true,
          expectedVersion: item.baseVersion
        },
        async () => {
          if (existing) {
            await this.deletePlotCascade(existing.id);
          }
        }
      );
      if (claimed === null) {
        throw new SyncVersionConflictError(SYNC_ENTITY_FARM_PLOT, item.entityId);
      }
      return claimed.version;
    }

    const input = parseSyncedPlotPayload(item.payload);
    this.assertValidPlot(input);
    const now = new Date().toISOString();
    const claimed = await entityVersions.applyGuarded(
      {
        entity: SYNC_ENTITY_FARM_PLOT,
        entityId: item.entityId,
        ownerId: existing?.ownerUserId ?? actor.id,
        updatedBy: actor.id,
        deleted: false,
        expectedVersion: item.baseVersion
      },
      async () => {
        if (existing) {
          await this.plots.update(existing.id, {
            name: input.name,
            state: input.state,
            lga: input.lga,
            centroidLat: input.centroidLat,
            centroidLong: input.centroidLong,
            boundaryGeojson: input.boundaryGeojson,
            sizeHectares: input.sizeHectares,
            soilType: input.soilType,
            updatedAt: now,
            version: existing.version + 1
          });
        } else {
          // Create with the client-stable entity id — the sync ledger and
          // the source row share one identity, so pulls map 1:1 onto pushed
          // records.
          await this.plots.create({
            id: item.entityId,
            ownerUserId: actor.id,
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
            clientId: input.clientId ?? item.clientMutationId
          });
        }
      }
    );
    if (claimed === null) {
      throw new SyncVersionConflictError(SYNC_ENTITY_FARM_PLOT, item.entityId);
    }
    return claimed.version;
  }

  /* ----------------------------- plantings ----------------------------- */

  async createPlanting(
    actor: User | null,
    plotId: string,
    input: CreatePlantingInput
  ): Promise<CropPlanting> {
    const plot = await this.assertPlotAccess(actor, plotId);
    // A2: replant linkage — the predecessor must exist, live on the SAME
    // plot, and be terminal 'failed' (a replant is by definition a
    // replacement of a failed crop; linking a live one is a data bug and
    // fails closed).
    let replantOf: CropPlanting | undefined;
    if (input.replantOfId !== undefined) {
      replantOf = await this.plantings.getById(input.replantOfId);
      if (replantOf.plotId !== plot.id) {
        throw new BadRequestException(
          `replantOfId '${input.replantOfId}' belongs to a different plot — a replant must stay on the failed planting's plot`
        );
      }
      if (replantOf.status !== 'failed') {
        throw new BadRequestException(
          `replantOfId '${input.replantOfId}' is '${replantOf.status}', not 'failed' — only a failed planting can be replanted`
        );
      }
    }
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
      replantOfId: replantOf?.id,
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
      metadata: {
        plotId: plot.id,
        crop: created.crop,
        season: created.season,
        replantOfId: created.replantOfId
      }
    });
    await this.events.publish(
      'farms.planting.created',
      {
        plantingId: created.id,
        plotId: plot.id,
        crop: created.crop,
        replantOfId: created.replantOfId
      },
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
    status: PlantingStatus,
    options?: { failureReason?: PlantingFailureReason }
  ): Promise<CropPlanting> {
    const planting = await this.plantings.getById(plantingId);
    const plot = await this.assertPlotAccess(actor, planting.plotId);
    if (planting.status === status) {
      return planting; // idempotent replay of a retry
    }
    const allowed = PLANTING_STATUS_TRANSITIONS[planting.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Invalid planting status transition from '${planting.status}' to '${status}'`
      );
    }
    // Fail-closed contract input: a failure transition MUST carry a reason
    // (the V-03 crop-failure→loan subscriber keys on it), and a reason on a
    // non-failure transition is a caller bug.
    if (status === 'failed') {
      if (!options?.failureReason || !PLANTING_FAILURE_REASONS.includes(options.failureReason)) {
        throw new BadRequestException(
          `failureReason is required when marking a planting failed (${PLANTING_FAILURE_REASONS.join(' | ')})`
        );
      }
    } else if (options?.failureReason !== undefined) {
      throw new BadRequestException('failureReason only applies to the failed transition');
    }
    const occurredAt = new Date().toISOString();
    const updated = await this.plantings.update(plantingId, {
      status,
      failureReason: status === 'failed' ? options!.failureReason : planting.failureReason,
      updatedAt: occurredAt,
      version: planting.version + 1
    });
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.planting_status_changed',
      entityType: 'crop_planting',
      entityId: plantingId,
      metadata: {
        from: planting.status,
        to: status,
        failureReason: updated.failureReason
      }
    });
    /**
     * EVENT CONTRACT (V-03 — consumed by the crop-failure→loan grace
     * subscriber owned by another pack; do NOT rename/remove fields without
     * coordinating):
     * on a transition to 'failed' the payload RELIABLY carries
     *   plantingId, plotId, ownerId (the farmer), cropType, failureReason,
     *   occurredAt (ISO-8601), plus the legacy from/to.
     * The subscriber MUST treat ownerId as the farmer identity and
     * occurredAt as the failure timestamp; both are stamped server-side
     * here, never caller-supplied.
     */
    await this.events.publish(
      'farms.planting.status_changed',
      status === 'failed'
        ? {
            plantingId,
            plotId: planting.plotId,
            ownerId: plot.ownerUserId,
            cropType: planting.crop,
            failureReason: updated.failureReason,
            occurredAt,
            from: planting.status,
            to: status
          }
        : { plantingId, plotId: planting.plotId, from: planting.status, to: status },
      actor!.id
    );
    return updated;
  }

  /* ------------------------------ harvests ----------------------------- */

  /**
   * Records a harvest pick against a planting (A3: staggered harvests).
   * The FIRST pick flips a growing planting to 'partially_harvested' — the
   * crop is still active, so advisory/expected-harvest logic stays correct
   * for the remaining picks. Further picks accumulate while the planting is
   * 'partially_harvested'; the farmer closes the season explicitly
   * (partially_harvested → harvested via updatePlantingStatus). Failed and
   * fully-harvested plantings cannot be harvested.
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
    if (planting.status === 'harvested') {
      throw new BadRequestException(
        `Planting '${plantingId}' is fully harvested; reopen the season with a new planting instead`
      );
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
      const occurredAt = new Date().toISOString();
      await this.plantings.update(planting.id, {
        status: 'partially_harvested',
        updatedAt: occurredAt,
        version: planting.version + 1
      });
      // Lifecycle parity with updatePlantingStatus: downstream consumers
      // (advisory pulses) key on status_changed, so the first pick must
      // announce the state change just like a manual transition.
      await this.events.publish(
        'farms.planting.status_changed',
        {
          plantingId: planting.id,
          plotId: planting.plotId,
          from: 'growing',
          to: 'partially_harvested'
        },
        actor!.id
      );
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
    // A4: intercrop allocation — explicit shares or nothing. An expense
    // without allocations is PLOT-LEVEL (shared across the plot by the
    // documented default rule); it is NEVER silently full-attributed to one
    // planting. When allocations are supplied they must cover distinct
    // plantings on THIS plot and sum to exactly 100%.
    if (input.allocations !== undefined) {
      if (!this.expenseAllocations) {
        // Fail closed BEFORE any write: never record an expense whose
        // allocation cannot be persisted — that would silently revert to
        // plot-level attribution.
        throw new Error('Expense allocation persistence is not configured');
      }
      await this.assertValidExpenseAllocations(plot.id, input.allocations);
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
    if (input.allocations !== undefined) {
      await this.expenseAllocations!.record(created.id, input.allocations);
    }
    const allocations =
      input.allocations !== undefined ? input.allocations.map((a) => ({ ...a })) : undefined;
    await this.audit.record({
      actorId: actor!.id,
      action: 'farms.expense_recorded',
      entityType: 'farm_expense',
      entityId: created.id,
      metadata: {
        plotId: plot.id,
        category: created.category,
        amountKobo: created.amountKobo,
        allocations
      }
    });
    await this.events.publish(
      'farms.expense.recorded',
      {
        expenseId: created.id,
        plotId: plot.id,
        amountKobo: created.amountKobo,
        allocations
      },
      actor!.id
    );
    return { ...created, allocations };
  }

  /** A4: allocation shares must reference distinct plantings on the plot and total exactly 100%. */
  private async assertValidExpenseAllocations(
    plotId: string,
    allocations: FarmExpenseAllocation[]
  ): Promise<void> {
    if (allocations.length === 0) {
      throw new BadRequestException(
        'allocations must be omitted entirely (plot-level expense) or cover at least one planting'
      );
    }
    const seen = new Set<string>();
    let total = 0;
    for (const allocation of allocations) {
      if (
        typeof allocation.sharePercent !== 'number' ||
        !Number.isFinite(allocation.sharePercent) ||
        allocation.sharePercent <= 0 ||
        allocation.sharePercent > 100
      ) {
        throw new BadRequestException('sharePercent must be a number in (0, 100]');
      }
      if (seen.has(allocation.plantingId)) {
        throw new BadRequestException(
          `Duplicate allocation for planting '${allocation.plantingId}' — merge the shares`
        );
      }
      seen.add(allocation.plantingId);
      total += allocation.sharePercent;
      const planting = await this.plantings.getById(allocation.plantingId);
      if (planting.plotId !== plotId) {
        throw new BadRequestException(
          `Allocation planting '${allocation.plantingId}' belongs to a different plot`
        );
      }
    }
    if (Math.abs(total - 100) > 1e-9) {
      throw new BadRequestException(
        `Allocation shares must sum to exactly 100 (got ${total}) — a partial allocation would under-attribute the expense`
      );
    }
  }

  async listExpenses(actor: User | null, plotId: string): Promise<FarmExpense[]> {
    await this.assertPlotAccess(actor, plotId);
    const expenses = await this.expenses.find({ plotId });
    if (!this.expenseAllocations || expenses.length === 0) {
      return expenses;
    }
    const rows = await this.expenseAllocations.listForExpenses(expenses.map((e) => e.id));
    const byExpense = new Map<string, FarmExpenseAllocation[]>();
    for (const row of rows) {
      const list = byExpense.get(row.expenseId) ?? [];
      list.push({ plantingId: row.plantingId, sharePercent: row.sharePercent });
      byExpense.set(row.expenseId, list);
    }
    return expenses.map((expense) => {
      const allocations = byExpense.get(expense.id);
      return allocations ? { ...expense, allocations } : expense;
    });
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
        // 'partially_harvested' plantings still have picks outstanding
        // (A3) — they are active for summary purposes.
        if (planting.status === 'growing' || planting.status === 'partially_harvested') {
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
