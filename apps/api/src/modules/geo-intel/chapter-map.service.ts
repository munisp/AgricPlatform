import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import {
  CHAPTER_REPOSITORY,
  CHAPTER_MAP_SNAPSHOT_REPOSITORY,
  CHAPTER_MEMBER_DIRECTORY,
  EQUIPMENT_LISTING_REPOSITORY,
  ESCROW_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  H3_INDEX_REPOSITORY,
  INPUT_VOUCHER_REDEMPTION_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type {
  ChapterMapMetric,
  ChapterMapSnapshotRepository,
  ChapterMemberDirectory
} from '../../database/repositories/chapter-map.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type { H3IndexRepository } from '../../database/repositories/geo.repository.js';
import type {
  InputVoucherRepository,
  RedemptionRepository
} from '../../database/repositories/input-vouchers.repository.js';
import type { EquipmentListingRepository } from '../../database/repositories/mechanization.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { H3Service } from '../geo/h3.service.js';
import {
  aggregateChapterMap,
  applyKAnonymity,
  CHAPTER_MAP_SNAPSHOT_TTL_MS,
  chapterMapSnapshots,
  isSnapshotStale,
  K_ANONYMITY_FLOOR,
  type ChapterMapSourceData,
  type MemberRedemption
} from './chapter-map.js';

export interface ChapterMapCellView {
  /** H3 res-7 cell index; boundaries resolve via the existing GET /geo/cells/:h3. */
  h3: string;
  metric: ChapterMapMetric;
  value: number;
}

export interface ChapterMapView {
  chapterId: string;
  /** Metric filter applied, or null when all metrics are returned. */
  metric: ChapterMapMetric | null;
  cells: ChapterMapCellView[];
  /** Distinct cells hidden by the k-anonymity floor (count only, never values). */
  suppressedCellCount: number;
  kAnonymityFloor: number;
  /** Snapshot age honesty: null when the chapter map was never computed. */
  computedAt: string | null;
  /** True past the TTL — stale snapshots are badged, never presented as live. */
  stale: boolean;
  ttlMs: number;
}

export interface ChapterMapRecomputeResult {
  chapterId: string;
  computedAt: string;
  cellCount: number;
  rowCount: number;
  suppressedCellCount: number;
  kAnonymityFloor: number;
}

/**
 * Chapter Map aggregation service (Innovation 10, Stage 27). READ-ONLY over
 * the domain tables: it composes the existing geo-indexed data (chapter
 * roster, geo.h3_index profile/plot cells, voucher redemptions, active
 * mechanization service areas, held escrows) into per-chapter H3 res-7
 * metric snapshots (migration 068, recomputable cache) and serves them with
 * the k-anonymity floor and staleness badge enforced. Nothing here mutates
 * domain state, so there is no external dependency to fail closed against.
 */
@Injectable()
export class ChapterMapService {
  constructor(
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(CHAPTER_MEMBER_DIRECTORY) private readonly members: ChapterMemberDirectory,
    @Inject(H3_INDEX_REPOSITORY) private readonly h3Index: H3IndexRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(INPUT_VOUCHER_REPOSITORY) private readonly vouchers: InputVoucherRepository,
    @Inject(INPUT_VOUCHER_REDEMPTION_REPOSITORY) private readonly redemptions: RedemptionRepository,
    @Inject(EQUIPMENT_LISTING_REPOSITORY) private readonly equipment: EquipmentListingRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(CHAPTER_MAP_SNAPSHOT_REPOSITORY)
    private readonly snapshots: ChapterMapSnapshotRepository,
    private readonly h3: H3Service,
    private readonly telemetry: TelemetryService,
    private readonly events: DomainEventsService
  ) {}

  /**
   * Serves the cached snapshot with the k-anonymity floor applied: cells
   * below the floor are ABSENT from the response for every metric. Stale
   * snapshots are returned with stale=true and their real computedAt —
   * never presented as live.
   */
  /**
   * Chapter-lead resource scoping (V-14): the chapter map may be read by the
   * chapter's OWN lead or an admin — the role guard alone previously let ANY
   * chapter lead read EVERY chapter's map. Anonymous 401, wrong-chapter 403,
   * unknown chapter 404.
   */
  async assertMapReader(actor: User | null, chapterId: string): Promise<void> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    const chapter = await this.chapters.getById(chapterId); // 404s for unknown chapters
    if (!actor.roles.includes('admin') && chapter.leadUserId !== actor.id) {
      throw new ForbiddenException('Only the lead of this chapter or an admin may view its map');
    }
  }

  async getMap(chapterId: string, metric?: ChapterMapMetric): Promise<ChapterMapView> {
    await this.chapters.getById(chapterId); // 404s for unknown chapters
    const rows = await this.snapshots.findByChapter(chapterId);
    const { rows: visible, suppressedCellCount } = applyKAnonymity(rows);
    const filtered = metric ? visible.filter((row) => row.metric === metric) : visible;
    let computedAt: string | null = null;
    for (const row of rows) {
      if (computedAt === null || row.computedAt > computedAt) {
        computedAt = row.computedAt;
      }
    }
    return {
      chapterId,
      metric: metric ?? null,
      cells: filtered.map((row) => ({ h3: row.h3Res7, metric: row.metric, value: row.valueNumeric })),
      suppressedCellCount,
      kAnonymityFloor: K_ANONYMITY_FLOOR,
      computedAt,
      stale: isSnapshotStale(computedAt, Date.now()),
      ttlMs: CHAPTER_MAP_SNAPSHOT_TTL_MS
    };
  }

  /** Rebuilds the chapter's snapshots from the domain tables (idempotent PK upsert). */
  async recompute(chapterId: string, actorId?: string): Promise<ChapterMapRecomputeResult> {
    const startedMs = Date.now();
    return this.telemetry.withSpan('geo_intel.chapter_map.compute', { chapter_id: chapterId }, async () => {
      await this.chapters.getById(chapterId);
      const source = await this.gatherSource(chapterId);
      const cells = aggregateChapterMap(source, (cell, resolution) =>
        this.h3.parentAt(cell, resolution)
      );
      const computedAt = new Date().toISOString();
      const rows = chapterMapSnapshots(chapterId, cells, computedAt);
      await this.snapshots.upsertMany(rows);
      const { suppressedCellCount } = applyKAnonymity(rows);
      this.telemetry.increment('geo_intel.chapter_map_computes_total', 1, {
        chapter_id: chapterId
      });
      this.telemetry.record('geo_intel.chapter_map_compute_latency_ms', Date.now() - startedMs, {
        chapter_id: chapterId
      });
      await this.events.publish(
        'geo_intel.chapter_map.computed',
        {
          chapterId,
          cellCount: cells.size,
          rowCount: rows.length,
          suppressedCellCount
        },
        actorId
      );
      return {
        chapterId,
        computedAt,
        cellCount: cells.size,
        rowCount: rows.length,
        suppressedCellCount,
        kAnonymityFloor: K_ANONYMITY_FLOOR
      };
    });
  }

  /**
   * Composes the aggregation inputs from the existing repositories. Member
   * attribution follows the geo.h3_index profile cell; plots fall back to
   * their authoritative centroid when an index entry is missing; vouchers
   * and escrows owned by non-members (or members without an indexed
   * profile) are honestly skipped — never re-attributed by guesswork.
   */
  private async gatherSource(chapterId: string): Promise<ChapterMapSourceData> {
    const memberIds = await this.members.listMemberIds(chapterId);
    const memberSet = new Set(memberIds);

    const profileEntries = memberIds.length > 0 ? await this.h3Index.find({ entity: 'profile' }) : [];
    const memberCells = profileEntries
      .filter((entry) => memberSet.has(entry.entityId))
      .map((entry) => ({ userId: entry.entityId, cell: entry.h3Res7 }));

    const plotCellById = new Map(
      (await this.h3Index.find({ entity: 'farm_plot' })).map((entry) => [entry.entityId, entry.h3Res7])
    );
    const plots = (await this.plots.find({}))
      .filter((plot) => memberSet.has(plot.ownerUserId))
      .map((plot) => ({
        id: plot.id,
        ownerUserId: plot.ownerUserId,
        cell: plotCellById.get(plot.id) ?? this.h3.cellAt(plot.centroidLat, plot.centroidLong, 7),
        sizeHectares: plot.sizeHectares
      }));

    const farmerByVoucher = new Map(
      (await this.vouchers.find({})).map((voucher) => [voucher.id, voucher.farmerId])
    );
    const redemptions: MemberRedemption[] = (await this.redemptions.find({}))
      .map((redemption) => ({ id: redemption.id, farmerId: farmerByVoucher.get(redemption.voucherId) }))
      .filter(
        (redemption): redemption is MemberRedemption =>
          typeof redemption.farmerId === 'string' && memberSet.has(redemption.farmerId)
      );

    const sellerByOrder = new Map((await this.orders.find({})).map((order) => [order.id, order.sellerId]));
    const pendingEscrows = (await this.escrows.find({ status: 'held' }))
      .map((escrow) => ({
        id: escrow.id,
        sellerId: sellerByOrder.get(escrow.orderId),
        amountKobo: escrow.amountKobo
      }))
      .filter(
        (escrow): escrow is { id: string; sellerId: string; amountKobo: number } =>
          typeof escrow.sellerId === 'string' && memberSet.has(escrow.sellerId)
      );

    const serviceAreas = (await this.equipment.find({ status: 'active' })).map((listing) => ({
      id: listing.id,
      cells: listing.serviceAreaH3,
      resolution: listing.serviceAreaResolution
    }));

    return { chapterId, memberCells, plots, redemptions, serviceAreas, pendingEscrows };
  }
}
