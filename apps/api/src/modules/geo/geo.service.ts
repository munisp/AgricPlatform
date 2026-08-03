import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException
} from '@nestjs/common';
import {
  isValidBoundaryGeojson,
  pointInGeojsonGeometry,
  type FarmPlot,
  type GeoBoundary,
  type GeoBoundaryKind,
  type GeoCellBoundary,
  type GeoClustersResult,
  type GeoContainsResult,
  type GeoFarmsNearResult,
  type GeoIndexedEntity,
  type GeoReindexEntityReport,
  type GeoReindexResult,
  type H3IndexEntry,
  type Profile,
  type User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import {
  FARM_PLOT_REPOSITORY,
  GEO_BOUNDARY_REPOSITORY,
  H3_INDEX_REPOSITORY,
  PROFILE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type {
  GeoBoundaryRepository,
  H3IndexRepository
} from '../../database/repositories/geo.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import { H3Service } from './h3.service.js';

export interface GeoNearQuery {
  lat: number;
  long: number;
  res?: number;
  ring?: number;
}

export interface CreateGeoBoundaryInput {
  kind: GeoBoundaryKind;
  name: string;
  parentId?: string;
  boundaryGeojson: unknown;
}

export interface GeoContainsInput {
  lat: number;
  long: number;
  boundaryId?: string;
  geojson?: unknown;
}

/** Entities the H3 index covers; reindex reports exactly these. */
const INDEXED_ENTITIES: readonly GeoIndexedEntity[] = ['farm_plot', 'profile'];

/** Roles that see the whole index (field-agents manager scoping pattern). */
const GEO_MANAGER_ROLES = ['admin', 'partner', 'chapter_lead'] as const;

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for geospatial queries');
  }
  return actor;
}

function isGeoManager(user: User): boolean {
  return GEO_MANAGER_ROLES.some((role) => user.roles.includes(role));
}

function requireManager(actor: User | null): User {
  const user = requireActor(actor);
  if (!isGeoManager(user)) {
    throw new ForbiddenException('Administrator, partner or chapter lead role required');
  }
  return user;
}

function requireAdmin(actor: User | null): User {
  const user = requireActor(actor);
  if (!user.roles.includes('admin')) {
    throw new ForbiddenException('Administrator role required');
  }
  return user;
}

/**
 * Wave GEO geospatial pack: H3 indexing of every geo-located entity (no
 * PostGIS — cells are computed here via H3Service/h3-js and stored in
 * geo.h3_index), neighbourhood + cluster queries, named boundaries and the
 * point-in-boundary helper used later by livestock movement-permit checks.
 *
 * Indexing is event-driven: the module subscribes to the farms module's
 * domain events (farms.plot.created/updated/removed) WITHOUT modifying the
 * farms module — the geo module reads farm plots through the global
 * DatabaseModule port. POST /geo/reindex (admin, idempotent) backfills or
 * repairs the index from the source repositories.
 */
@Injectable()
export class GeoService implements OnModuleInit {
  private readonly logger = new Logger(GeoService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    private readonly h3: H3Service,
    @Inject(H3_INDEX_REPOSITORY) private readonly h3Index: H3IndexRepository,
    @Inject(GEO_BOUNDARY_REPOSITORY) private readonly boundaries: GeoBoundaryRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository
  ) {}

  /**
   * Registry-pattern hook: farm plots are auto-indexed on create/update and
   * de-indexed on removal via the farms module's domain events. Handlers are
   * fire-and-forget with logged failures — a failed index update never
   * breaks the source write; POST /geo/reindex repairs drift.
   */
  onModuleInit(): void {
    this.events.on('farms.plot.created', (event) => void this.onPlotIndexed(event));
    this.events.on('farms.plot.updated', (event) => void this.onPlotIndexed(event));
    this.events.on('farms.plot.removed', (event) => void this.onPlotRemoved(event));
  }

  private async onPlotIndexed(event: DomainEvent): Promise<void> {
    const plotId = (event.payload as { plotId?: string }).plotId;
    if (!plotId) {
      return;
    }
    try {
      const plot = await this.plots.findById(plotId);
      if (!plot) {
        return;
      }
      await this.indexFarmPlot(plot, event.actorId);
    } catch (error) {
      this.logger.error(`failed to index farm plot ${plotId}: ${(error as Error).message}`);
    }
  }

  private async onPlotRemoved(event: DomainEvent): Promise<void> {
    const plotId = (event.payload as { plotId?: string }).plotId;
    if (!plotId) {
      return;
    }
    try {
      const removed = await this.h3Index.removeByEntity('farm_plot', plotId);
      if (removed) {
        await this.events.publish(
          'geo.h3_index.removed',
          { entity: 'farm_plot', entityId: plotId },
          event.actorId
        );
      }
    } catch (error) {
      this.logger.error(`failed to de-index farm plot ${plotId}: ${(error as Error).message}`);
    }
  }

  /** Idempotent upsert of one plot's index row + index-update event. */
  private async indexFarmPlot(plot: FarmPlot, actorId?: string): Promise<H3IndexEntry> {
    const entry = this.buildEntry('farm_plot', plot.id, plot.centroidLat, plot.centroidLong);
    const stored = await this.h3Index.upsert(entry);
    await this.events.publish(
      'geo.h3_index.updated',
      { entity: 'farm_plot', entityId: plot.id, h3Res7: entry.h3Res7 },
      actorId
    );
    return stored;
  }

  private buildEntry(
    entity: GeoIndexedEntity,
    entityId: string,
    lat: number,
    long: number
  ): H3IndexEntry {
    return {
      entity,
      entityId,
      ...this.h3.indexPoint(lat, long),
      lat,
      long,
      updatedAt: new Date().toISOString()
    };
  }

  /* ------------------------------ reindex ------------------------------ */

  /**
   * Admin backfill/repair over every entity with a clean lat/long accessor:
   * farm plots (centroid) and member profiles (location.latitude/longitude,
   * when captured). Livestock aggregation points and marketplace listings
   * carry state/lga only — no coordinates — so they are intentionally NOT
   * indexed (documented in docs/geospatial.md). Upsert semantics make the
   * run idempotent; every run is audit-logged.
   */
  async reindex(actor: User | null): Promise<GeoReindexResult> {
    const admin = requireAdmin(actor);
    const reports: GeoReindexEntityReport[] = [];

    const allPlots = await this.plots.all();
    for (const plot of allPlots) {
      await this.h3Index.upsert(
        this.buildEntry('farm_plot', plot.id, plot.centroidLat, plot.centroidLong)
      );
    }
    reports.push({
      entity: 'farm_plot',
      scanned: allPlots.length,
      indexed: allPlots.length,
      skipped: 0
    });

    const allProfiles = await this.profiles.all();
    const located = allProfiles.filter((profile) => this.profileCoordinates(profile) !== null);
    for (const profile of located) {
      const [lat, long] = this.profileCoordinates(profile)!;
      await this.h3Index.upsert(this.buildEntry('profile', profile.userId, lat, long));
    }
    reports.push({
      entity: 'profile',
      scanned: allProfiles.length,
      indexed: located.length,
      skipped: allProfiles.length - located.length
    });

    await this.audit.record({
      actorId: admin.id,
      action: 'geo.reindex',
      entityType: 'h3_index',
      entityId: 'all',
      metadata: { reports }
    });
    await this.events.publish(
      'geo.h3_index.reindexed',
      { reports: reports.map((report) => ({ ...report })) },
      admin.id
    );
    return { reports };
  }

  private profileCoordinates(profile: Profile): [number, number] | null {
    const lat = profile.location?.latitude;
    const long = profile.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(long)) {
      return null;
    }
    return [lat as number, long as number];
  }

  /* ------------------------------ queries ------------------------------ */

  /**
   * Farms inside the k-ring around the cell containing (lat, long). Managers
   * (admin/partner/chapter_lead) see every plot; everyone else is pinned to
   * their own plots (farms owner-scoping pattern).
   */
  async farmsNear(actor: User | null, query: GeoNearQuery): Promise<GeoFarmsNearResult> {
    const caller = requireActor(actor);
    const resolution = this.h3.assertResolution(query.res ?? 7);
    const centerCell = this.h3.cellAt(query.lat, query.long, resolution);
    const cells = this.h3.disk(centerCell, query.ring ?? 1);
    const entries = await this.h3Index.findByCells('farm_plot', resolution, cells);
    const plots: FarmPlot[] = [];
    for (const entry of entries) {
      const plot = await this.plots.findById(entry.entityId);
      if (plot && (isGeoManager(caller) || plot.ownerUserId === caller.id)) {
        plots.push(plot);
      }
    }
    plots.sort((a, b) => a.id.localeCompare(b.id));
    return { centerCell, resolution, ring: query.ring ?? 1, plots };
  }

  /**
   * Indexed-farm counts per H3 cell at the requested resolution (default 5,
   * state/LGA-scale map rendering). Manager roles only — exact farm
   * distributions are operationally sensitive.
   */
  async farmClusters(actor: User | null, res = 5): Promise<GeoClustersResult> {
    requireManager(actor);
    const resolution = this.h3.assertResolution(res);
    const entries = await this.h3Index.find({ entity: 'farm_plot' });
    const column = resolution === 5 ? 'h3Res5' : resolution === 7 ? 'h3Res7' : 'h3Res9';
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const cell = entry[column];
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
    const cells = [...counts.entries()]
      .map(([cell, count]) => ({ cell, count }))
      .sort((a, b) => b.count - a.count || a.cell.localeCompare(b.cell));
    return { entity: 'farm_plot', resolution, cells, total: entries.length };
  }

  /** Cell boundary as closed GeoJSON for map rendering. */
  cellBoundary(actor: User | null, cell: string): GeoCellBoundary {
    requireActor(actor);
    return {
      cell,
      resolution: this.h3.resolutionOf(cell),
      boundary: this.h3.boundaryGeojson(cell)
    };
  }

  /* ----------------------------- boundaries ---------------------------- */

  async listBoundaries(actor: User | null, kind?: GeoBoundaryKind): Promise<GeoBoundary[]> {
    requireActor(actor);
    return this.boundaries.find(kind ? { kind } : {});
  }

  /** Admin-managed boundaries (states/LGAs/wards/custom zones). */
  async createBoundary(actor: User | null, input: CreateGeoBoundaryInput): Promise<GeoBoundary> {
    const admin = requireAdmin(actor);
    if (!input.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!isValidBoundaryGeojson(input.boundaryGeojson)) {
      throw new BadRequestException(
        'boundaryGeojson must be a GeoJSON Polygon or MultiPolygon geometry'
      );
    }
    if (input.parentId) {
      await this.boundaries.getById(input.parentId); // 404 when missing
    }
    const boundary = await this.boundaries.create({
      id: newId('geob'),
      kind: input.kind,
      name: input.name.trim(),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      boundaryGeojson: input.boundaryGeojson,
      createdAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: admin.id,
      action: 'geo.boundary_created',
      entityType: 'geo_boundary',
      entityId: boundary.id,
      metadata: { kind: boundary.kind, name: boundary.name, parentId: boundary.parentId }
    });
    await this.events.publish(
      'geo.boundary.created',
      { boundaryId: boundary.id, kind: boundary.kind, name: boundary.name },
      admin.id
    );
    return boundary;
  }

  /**
   * Point-in-boundary check (ray casting over GeoJSON polygons — no
   * geometry library, no PostGIS). Accepts either a stored boundaryId or an
   * inline GeoJSON geometry. Introduced for livestock movement-permit zone
   * checks (docs/geospatial.md); a point exactly on an edge counts as in.
   */
  async contains(actor: User | null, input: GeoContainsInput): Promise<GeoContainsResult> {
    requireActor(actor);
    this.h3.assertCoordinates(input.lat, input.long);
    if ((input.boundaryId ? 1 : 0) + (input.geojson !== undefined ? 1 : 0) !== 1) {
      throw new BadRequestException('Provide exactly one of boundaryId or geojson');
    }
    const geometry = input.boundaryId
      ? (await this.boundaries.getById(input.boundaryId)).boundaryGeojson
      : input.geojson;
    if (!isValidBoundaryGeojson(geometry)) {
      throw new BadRequestException('geometry must be a GeoJSON Polygon or MultiPolygon');
    }
    return { contains: pointInGeojsonGeometry([input.long, input.lat], geometry) };
  }

  /** Entities the reindex covers — surfaced for documentation/tests. */
  indexedEntities(): readonly GeoIndexedEntity[] {
    return INDEXED_ENTITIES;
  }
}
