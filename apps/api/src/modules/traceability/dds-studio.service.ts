import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TenantContext } from '../../common/telemetry/tenant-context.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  COMMODITY_LOT_REPOSITORY,
  CUSTODY_EVENT_REPOSITORY,
  DDS_PACKAGE_REPOSITORY,
  LOT_PLOT_LINK_REPOSITORY,
  TRACEABILITY_SHIPMENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  DdsPackage,
  DdsPackageRepository
} from '../../database/repositories/dds-package.repository.js';
import type {
  CommodityLotRepository,
  CustodyEventRepository,
  LotPlotLinkRepository,
  TraceabilityShipmentRepository
} from '../../database/repositories/traceability.repository.js';
import {
  buildEvidenceManifest,
  computePackageHash,
  validateDdsEvidence,
  type DdsEvidenceBundle,
  type DdsEvidenceLot,
  type DdsEvidenceManifest,
  type DdsValidationResult
} from './dds-validator.js';
import { AGGREGATOR_ROLES } from './traceability.service.js';
import type { CommodityLot, TraceabilityShipment } from './traceability.types.js';

/** Deterministic DDS statement JSON embedded in the exported package. */
export interface DdsStatement {
  statementVersion: '1.0';
  ddsReference: string;
  operator: {
    status: 'TO_BE_COMPLETED_BY_EXPORTER';
    legalName: string | null;
    eori: string | null;
    address: string | null;
    note: string;
  };
  commodity: { description: string; crops: string[] };
  quantity: { value: number; unit: string };
  countryOfProduction: 'NG';
  productionPlots: Array<{
    plotId: string;
    lotId: string;
    latitude: number;
    longitude: number;
    h3Cell?: string;
    snapshotAt: string;
  }>;
  harvestWindow: { start: string; end: string };
  custodySummary: { lotCount: number; eventCount: number; eventTypes: string[] };
  chainIntegrity: {
    verified: boolean;
    lots: Array<{ lotId: string; eventCount: number; headHash: string | null }>;
  };
  disclaimers: string[];
}

/** The exported, hash-manifested DDS package (DDS JSON + evidence annex). */
export interface DdsExportDocument {
  packageId: string;
  shipmentId: string;
  status: 'exported';
  packageHash: string;
  exportedAt: string;
  exporterPartnerId?: string;
  dds: DdsStatement;
  evidenceAnnex: DdsEvidenceManifest;
}

const OPERATOR_NOTE =
  'Placeholder block: the exporting legal entity must complete operator name, EORI ' +
  'number and address before submission to the EU Information System. Legal DDS ' +
  'submission is an external gate outside this platform.';

const DDS_DISCLAIMERS = [
  'Operator block is a placeholder: the exporter legal entity must supply name, EORI and address; legal DDS submission to the EU Information System is an external gate not performed by this platform.',
  'Geolocation evidence consists of immutable point snapshots taken at plot-link time; the platform does not capture plot polygons, so plots above 4 ha require the exporter to source polygon evidence elsewhere.',
  'Chain integrity is anchored by the append-only custody hash chain; the package hash covers the exact evidence manifest exported here — any later evidence rewrite yields a different hash.',
  'No integration with the EU Information System has been performed or verified.'
];

function isAdmin(actor: User): boolean {
  return actor.roles.includes('admin');
}

function isAggregator(actor: User): boolean {
  return actor.roles.some((role) => (AGGREGATOR_ROLES as readonly string[]).includes(role));
}

function tenantOf(fallback: string): string {
  return TenantContext.currentTenantId() ?? fallback;
}

/**
 * DDS Studio (stage 27 innovation 17): assembles, validates and exports EUDR
 * due-diligence statement packages over the existing traceability evidence
 * (lots, append-only custody chain, immutable plot snapshots, shipments).
 * The validator is pure and never auto-fixes; a failed validation keeps the
 * package in draft with the missing items named. Export is a guarded status
 * CAS (validated → exported) whose package_hash anchors the exact evidence
 * manifest — the same shipment + evidence always yields the same hash, and
 * exported packages are immutable.
 */
@Injectable()
export class DdsStudioService {
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(COMMODITY_LOT_REPOSITORY) private readonly lots: CommodityLotRepository,
    @Inject(CUSTODY_EVENT_REPOSITORY) private readonly custodyEvents: CustodyEventRepository,
    @Inject(LOT_PLOT_LINK_REPOSITORY) private readonly plotLinks: LotPlotLinkRepository,
    @Inject(TRACEABILITY_SHIPMENT_REPOSITORY)
    private readonly shipments: TraceabilityShipmentRepository,
    @Inject(DDS_PACKAGE_REPOSITORY) private readonly packages: DdsPackageRepository,
    @Optional() telemetry?: TelemetryService
  ) {
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /* --------------------------- authorisation --------------------------- */

  private async assertLotReadAccess(actor: User, lot: CommodityLot): Promise<void> {
    if (actor.id === lot.ownerUserId || isAdmin(actor)) {
      return;
    }
    if (isAggregator(actor)) {
      const trail = await this.custodyEvents.listByLot(lot.id);
      if (trail.some((event) => event.actorId === actor.id)) {
        return;
      }
    }
    throw new ForbiddenException('You may only build DDS packages over lots you own or hold custody of');
  }

  /** Mirrors TraceabilityService.getShipment read rules (creator, admin, or can-read-every-lot). */
  private async assertShipmentReadAccess(actor: User, shipment: TraceabilityShipment): Promise<void> {
    if (shipment.creatorId === actor.id || isAdmin(actor)) {
      return;
    }
    const links = await this.shipments.listLots(shipment.id);
    for (const link of links) {
      await this.assertLotReadAccess(actor, await this.lots.getById(link.lotId));
    }
  }

  private async assertPackageReadAccess(actor: User, pkg: DdsPackage): Promise<void> {
    if (pkg.createdBy === actor.id || isAdmin(actor)) {
      return;
    }
    const shipment = await this.shipments.getById(pkg.shipmentId);
    await this.assertShipmentReadAccess(actor, shipment);
  }

  private assertPartnerPackageAccess(clientId: string, pkg: DdsPackage): void {
    if (pkg.exporterPartnerId !== clientId) {
      throw new ForbiddenException('Partners may only access DDS packages they created');
    }
  }

  /* --------------------------- evidence assembly ----------------------- */

  private async assembleEvidence(shipmentId: string): Promise<DdsEvidenceBundle> {
    const shipment = await this.shipments.getById(shipmentId);
    const links = await this.shipments.listLots(shipmentId);
    const lots: DdsEvidenceLot[] = [];
    for (const link of links) {
      const lot = await this.lots.getById(link.lotId);
      lots.push({
        lot,
        custodyEvents: await this.custodyEvents.listByLot(lot.id),
        plotLinks: await this.plotLinks.find({ lotId: lot.id })
      });
    }
    return { shipmentId, reference: shipment.reference, lots };
  }

  /* ------------------------------- drafts ------------------------------ */

  private async createDraft(
    shipment: TraceabilityShipment,
    createdBy: string,
    exporterPartnerId: string | undefined,
    tenantFallback: string
  ): Promise<DdsPackage> {
    const pkg: DdsPackage = {
      id: newId('dds'),
      shipmentId: shipment.id,
      status: 'draft',
      checklist: [],
      exporterPartnerId,
      createdBy,
      createdAt: new Date().toISOString()
    };
    await this.packages.create(pkg);
    await this.audit.record({
      actorId: createdBy,
      action: 'traceability.dds_package_created',
      entityType: 'dds_package',
      entityId: pkg.id,
      metadata: { shipmentId: shipment.id, exporterPartnerId: exporterPartnerId ?? null }
    });
    await this.events.publish(
      'traceability.dds.created',
      {
        packageId: pkg.id,
        shipmentId: shipment.id,
        exporterPartnerId: exporterPartnerId ?? null,
        tenantId: tenantOf(tenantFallback)
      },
      createdBy
    );
    return pkg;
  }

  async createDraftForUser(actor: User | null, shipmentId: string): Promise<DdsPackage> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for DDS packages');
    }
    const shipment = await this.shipments.getById(shipmentId);
    await this.assertShipmentReadAccess(actor, shipment);
    return this.createDraft(shipment, actor.id, undefined, `user:${actor.id}`);
  }

  /** Partner/exporter draft (scope traceability:dds); confined to the partner's own shipments. */
  async createDraftForPartner(clientId: string, shipmentId: string): Promise<DdsPackage> {
    const shipment = await this.shipments.getById(shipmentId);
    if (shipment.creatorId !== `partner:${clientId}`) {
      throw new ForbiddenException('Partners may only build DDS packages over their own shipments');
    }
    return this.createDraft(shipment, `partner:${clientId}`, clientId, `partner:${clientId}`);
  }

  /* ----------------------------- validation ---------------------------- */

  private async validatePackage(pkg: DdsPackage, actorId: string, tenantFallback: string) {
    if (pkg.status === 'exported') {
      throw new ConflictException(`DDS package '${pkg.id}' is exported and immutable`);
    }
    const bundle = await this.assembleEvidence(pkg.shipmentId);
    const startedAt = Date.now();
    const validation = await this.telemetry.withSpan(
      'traceability.dds.validate',
      { 'tenant.id': tenantOf(tenantFallback), lot_count: bundle.lots.length },
      () => validateDdsEvidence(bundle)
    );
    this.telemetry.record('traceability.dds_validate_latency_ms', Date.now() - startedAt, {
      result: validation.result
    });
    this.telemetry.increment('traceability.dds_validations_total', 1, { result: validation.result });

    // Failed validations STAY in draft — a DDS is never auto-passed.
    const nextStatus = validation.result === 'pass' ? 'validated' : 'draft';
    const saved = await this.packages.saveChecklist(pkg.id, nextStatus, validation.items);
    await this.audit.record({
      actorId,
      action: 'traceability.dds_package_validated',
      entityType: 'dds_package',
      entityId: pkg.id,
      metadata: { shipmentId: pkg.shipmentId, result: validation.result, lotCount: bundle.lots.length }
    });
    await this.events.publish(
      'traceability.dds.validated',
      {
        packageId: pkg.id,
        shipmentId: pkg.shipmentId,
        result: validation.result,
        lotCount: bundle.lots.length,
        failedRequirements: validation.items.filter((entry) => !entry.passed).map((entry) => entry.requirement),
        tenantId: tenantOf(tenantFallback)
      },
      actorId
    );
    return { package: saved, validation };
  }

  async validateForUser(
    actor: User | null,
    packageId: string
  ): Promise<{ package: DdsPackage; validation: DdsValidationResult }> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for DDS packages');
    }
    const pkg = await this.packages.getById(packageId);
    await this.assertPackageReadAccess(actor, pkg);
    return this.validatePackage(pkg, actor.id, `user:${actor.id}`);
  }

  /** Partner-scoped validation (scope traceability:dds). */
  async validateForPartner(
    clientId: string,
    packageId: string
  ): Promise<{ package: DdsPackage; validation: DdsValidationResult }> {
    const pkg = await this.packages.getById(packageId);
    this.assertPartnerPackageAccess(clientId, pkg);
    return this.validatePackage(pkg, `partner:${clientId}`, `partner:${clientId}`);
  }

  /* ------------------------------- export ------------------------------ */

  /**
   * Builds the deterministic DDS statement from the evidence manifest alone —
   * no wall-clock fields, no external calls — so the same evidence always
   * serialises identically.
   */
  private buildStatement(manifest: DdsEvidenceManifest): DdsStatement {
    const productionPlots: DdsStatement['productionPlots'] = [];
    const eventTypes = new Set<string>();
    let eventCount = 0;
    for (const lot of manifest.lots) {
      eventCount += lot.custodyEventHashes.length;
      for (const type of lot.custodyEventTypes) {
        eventTypes.add(type);
      }
      for (const snapshot of lot.plotSnapshots) {
        productionPlots.push({
          plotId: snapshot.plotId,
          lotId: lot.lotId,
          latitude: snapshot.latitude,
          longitude: snapshot.longitude,
          ...(snapshot.h3Cell ? { h3Cell: snapshot.h3Cell } : {}),
          snapshotAt: snapshot.linkedAt
        });
      }
    }
    const units = [...new Set(manifest.lots.map((lot) => lot.unit))];
    return {
      statementVersion: '1.0',
      ddsReference: manifest.shipmentId,
      operator: {
        status: 'TO_BE_COMPLETED_BY_EXPORTER',
        legalName: null,
        eori: null,
        address: null,
        note: OPERATOR_NOTE
      },
      commodity: {
        description: manifest.lots.map((lot) => lot.crop).join(', '),
        crops: [...new Set(manifest.lots.map((lot) => lot.crop))]
      },
      quantity: {
        value: manifest.lots.reduce((sum, lot) => sum + lot.quantity, 0),
        unit: units.length === 1 ? units[0] : 'mixed'
      },
      countryOfProduction: 'NG',
      productionPlots,
      harvestWindow: {
        start: manifest.lots.map((lot) => lot.harvestWindowStart).sort()[0] ?? '',
        end: manifest.lots.map((lot) => lot.harvestWindowEnd).sort().slice(-1)[0] ?? ''
      },
      custodySummary: {
        lotCount: manifest.lots.length,
        eventCount,
        eventTypes: [...eventTypes].sort()
      },
      chainIntegrity: {
        verified: true, // export is gated on a fully passing validation
        lots: manifest.lots.map((lot) => ({
          lotId: lot.lotId,
          eventCount: lot.custodyEventHashes.length,
          headHash: lot.headEventHash
        }))
      },
      disclaimers: [...DDS_DISCLAIMERS]
    };
  }

  private buildExportDocument(pkg: DdsPackage & { status: 'exported' }, manifest: DdsEvidenceManifest): DdsExportDocument {
    return {
      packageId: pkg.id,
      shipmentId: pkg.shipmentId,
      status: 'exported',
      packageHash: pkg.packageHash!,
      exportedAt: pkg.exportedAt!,
      ...(pkg.exporterPartnerId ? { exporterPartnerId: pkg.exporterPartnerId } : {}),
      dds: this.buildStatement(manifest),
      evidenceAnnex: manifest
    };
  }

  /**
   * Export path: the package must be validated (pass) — drafts and failed
   * validations fail closed. The first export runs the guarded CAS and
   * anchors the package hash in the audit chain; later reads rebuild the
   * deterministic document and verify it still matches the stored hash
   * (evidence drift surfaces as a conflict instead of a silent re-export).
   */
  private async exportPackage(
    pkg: DdsPackage,
    actorId: string,
    tenantFallback: string
  ): Promise<DdsExportDocument> {
    const bundle = await this.assembleEvidence(pkg.shipmentId);
    if (pkg.status === 'exported') {
      const manifest = buildEvidenceManifest(bundle, pkg.checklist);
      const recomputed = computePackageHash(manifest);
      if (recomputed !== pkg.packageHash) {
        throw new ConflictException(
          `DDS package '${pkg.id}' evidence has drifted since export (stored hash does not recompute); the exported package is immutable`
        );
      }
      return this.buildExportDocument(pkg as DdsPackage & { status: 'exported' }, manifest);
    }
    if (pkg.status !== 'validated') {
      throw new ConflictException(
        `DDS package '${pkg.id}' is '${pkg.status}' — export requires a passing validation first (a DDS is never auto-passed)`
      );
    }
    const manifest = buildEvidenceManifest(bundle, pkg.checklist);
    const packageHash = computePackageHash(manifest);
    const exportedAt = new Date().toISOString();
    const exported = await this.packages.markExported(pkg.id, packageHash, exportedAt);
    // Audit-chain anchor on export: the export event (with the package hash)
    // is appended to the tamper-evident audit chain in the same action.
    await this.audit.record({
      actorId,
      action: 'traceability.dds_package_exported',
      entityType: 'dds_package',
      entityId: pkg.id,
      metadata: { shipmentId: pkg.shipmentId, packageHash, lotCount: bundle.lots.length }
    });
    await this.events.publish(
      'traceability.dds.exported',
      {
        packageId: pkg.id,
        shipmentId: pkg.shipmentId,
        packageHash,
        lotCount: bundle.lots.length,
        tenantId: tenantOf(tenantFallback)
      },
      actorId
    );
    this.telemetry.increment('traceability.dds_exports_total');
    return this.buildExportDocument(exported as DdsPackage & { status: 'exported' }, manifest);
  }

  async exportForUser(actor: User | null, packageId: string): Promise<DdsExportDocument> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for DDS packages');
    }
    const pkg = await this.packages.getById(packageId);
    await this.assertPackageReadAccess(actor, pkg);
    return this.exportPackage(pkg, actor.id, `user:${actor.id}`);
  }

  /** Partner-scoped export (scope traceability:dds). */
  async exportForPartner(clientId: string, packageId: string): Promise<DdsExportDocument> {
    const pkg = await this.packages.getById(packageId);
    this.assertPartnerPackageAccess(clientId, pkg);
    return this.exportPackage(pkg, `partner:${clientId}`, `partner:${clientId}`);
  }

  /** Read a package (checklist included) for the creator/admin or the owning partner. */
  async getPackageForUser(actor: User | null, packageId: string): Promise<DdsPackage> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for DDS packages');
    }
    const pkg = await this.packages.getById(packageId);
    await this.assertPackageReadAccess(actor, pkg);
    return pkg;
  }

  async getPackageForPartner(clientId: string, packageId: string): Promise<DdsPackage> {
    const pkg = await this.packages.getById(packageId);
    this.assertPartnerPackageAccess(clientId, pkg);
    return pkg;
  }
}
