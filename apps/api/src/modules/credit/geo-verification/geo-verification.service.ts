import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type {
  CreditLoanApplication,
  CreditLoanStatus,
  FarmPlot,
  GeoCreditShadowScore
} from '@agric-platform/shared';
import { newId } from '../../../common/async-repository.js';
import { AuditService } from '../../../core/audit.service.js';
import {
  CREDIT_LOAN_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  GEO_CREDIT_SHADOW_REPOSITORY
} from '../../../database/persistence.tokens.js';
import type { CreditLoanRepository } from '../../../database/repositories/credit-suite.repository.js';
import type { FarmPlotRepository } from '../../../database/repositories/farms.repository.js';
import type { GeoCreditShadowRepository } from '../../../database/repositories/geo-credit-shadow.repository.js';
import {
  createFloodRiskDriver,
  ProviderConfigError as FloodConfigError,
  ProviderHttpError as FloodHttpError,
  ProviderRequestError as FloodRequestError,
  type FloodRiskDriver
} from '../../geo-intel/flood-risk.drivers.js';
import { isCreditReviewer, type CreditActor } from '../credit.service.js';
import {
  createCropIntelClient,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  type CropIntelClient
} from './crop-intel.drivers.js';
import {
  computeGeoCreditFactor,
  computeInputFingerprint,
  estimateBoundaryAreaHectares,
  floodBandFromSeverity,
  type FloodRiskBand
} from './geo-credit-factor.js';

export type GeoCreditMode = 'off' | 'shadow';

/** Applications considered "open" for batch shadow recomputation. */
export const GEO_SHADOW_OPEN_STATUSES: readonly CreditLoanStatus[] = [
  'submitted',
  'scoring',
  'approved'
];

export interface GeoShadowRecomputeReport {
  mode: GeoCreditMode;
  applications: number;
  recomputed: number;
  /** Unchanged input fingerprint — no new row written. */
  skipped: number;
  /** Live crop-ml configured but unreachable — fail-closed, no score. */
  unavailable: number;
  /** Unexpected per-application errors (batch continues). */
  failed: number;
  computedAt: string;
}

function requireReviewer(actor: CreditActor): void {
  if (!isCreditReviewer(actor)) {
    throw new ForbiddenException('Only admin or lender reviewers may view geo shadow scores');
  }
}

function requireAdmin(actor: CreditActor): void {
  if (!actor.roles.includes('admin')) {
    throw new ForbiddenException('Only administrators may recompute geo shadow scores');
  }
}

/**
 * Geo-verified credit — SHADOW MODE orchestration (wave-geocredit).
 *
 * Computes the deterministic sixth factor from geospatial plot verification
 * and persists it ONLY to credit.geo_credit_shadow_scores. The live
 * approve/decline path (CreditService.score/approve/reject) never injects
 * or reads this service — decision-path neutrality is asserted by test.
 *
 * Fail-closed doctrine (mirrors geo-intel/flood-ml): when CROP_ML_DRIVER=http
 * is configured but the sidecar is unreachable, the factor records
 * status 'unavailable' with basis.crop='unavailable' and on-demand reads
 * answer 503. The stub is NEVER silently substituted for a configured live
 * provider. GEO_CREDIT_MODE=off disables the endpoints entirely; there is
 * NO 'live' mode in this wave (activation requires model validation and
 * fair-lending legal review — docs/geo-verified-credit.md).
 */
@Injectable()
export class GeoVerificationService {
  private floodDriver: FloodRiskDriver | undefined;
  private cropClient: CropIntelClient | undefined;

  constructor(
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(GEO_CREDIT_SHADOW_REPOSITORY) private readonly shadow: GeoCreditShadowRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  /** Read fresh each call so tests and deploys can flip without restart. */
  mode(env: NodeJS.ProcessEnv = process.env): GeoCreditMode {
    return (env.GEO_CREDIT_MODE ?? 'shadow').toLowerCase() === 'off' ? 'off' : 'shadow';
  }

  /** Visible for tests: rebuild lazily-resolved provider clients after env changes. */
  resetProvidersForTests(): void {
    this.floodDriver = undefined;
    this.cropClient = undefined;
  }

  private resolveFloodDriver(): FloodRiskDriver {
    if (!this.floodDriver) {
      this.floodDriver = createFloodRiskDriver();
    }
    return this.floodDriver;
  }

  private resolveCropClient(): CropIntelClient {
    if (!this.cropClient) {
      this.cropClient = createCropIntelClient();
    }
    return this.cropClient;
  }

  private assertEnabled(): void {
    if (this.mode() === 'off') {
      throw new NotFoundException(
        'Geo-verified credit is disabled on this deployment (GEO_CREDIT_MODE=off)'
      );
    }
  }

  /**
   * Deterministic plot resolution: the applicant's earliest-registered plot
   * that carries centroid coordinates (ties broken by id). Documented in
   * docs/geo-verified-credit.md so officers can reproduce the pick.
   */
  private async primaryPlot(applicantUserId: string): Promise<FarmPlot | undefined> {
    const owned = await this.plots.find({ ownerUserId: applicantUserId });
    return owned
      .filter(
        (plot) => typeof plot.centroidLat === 'number' && typeof plot.centroidLong === 'number'
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  }

  /**
   * Computes the shadow factor for an application. Pure apart from provider
   * calls; the same repository state and providers yield the same output.
   */
  async computeForApplication(
    loan: CreditLoanApplication,
    nowIso: string = new Date().toISOString()
  ): Promise<GeoCreditShadowScore> {
    const plot = await this.primaryPlot(loan.applicantUserId);
    const plotVerified = plot !== undefined;

    const areaHectares = plot
      ? (estimateBoundaryAreaHectares(plot.boundaryGeojson) ?? plot.sizeHectares ?? null)
      : null;

    // Flood input via the geo-intel driver port. Provider failures fail
    // closed as 503 (never a fabricated band) — same doctrine as geo-intel.
    const floodDriver = this.resolveFloodDriver();
    const floodBasis = floodDriver.name === 'http' ? ('live' as const) : ('stub' as const);
    let floodBand: FloodRiskBand = 'none';
    if (plot) {
      let assessment;
      try {
        assessment = await floodDriver.assess({
          latitude: plot.centroidLat,
          longitude: plot.centroidLong
        });
      } catch (error) {
        if (
          error instanceof FloodConfigError ||
          error instanceof FloodHttpError ||
          error instanceof FloodRequestError
        ) {
          throw new ServiceUnavailableException(
            'Flood-risk assessment is unavailable: the flood-ml sidecar could not be reached.'
          );
        }
        throw error;
      }
      floodBand = floodBandFromSeverity(assessment.severity);
    }

    // Crop input via the crop-ml client port. Fail-closed: configured live
    // but unreachable → status 'unavailable', basis.crop 'unavailable', NO
    // score — the stub is never silently substituted.
    let cropHealthScore: number | null = null;
    let cropBasis: GeoCreditShadowScore['basis']['crop'] = 'stub';
    let status: GeoCreditShadowScore['status'] = 'computed';
    if (plot) {
      try {
        const cropClient = this.resolveCropClient();
        cropBasis = cropClient.name === 'http' ? 'live' : 'stub';
        const crop = await cropClient.assessPlot({
          plotId: plot.id,
          geometry: plot.boundaryGeojson
        });
        cropHealthScore = crop.healthScore;
        cropBasis = crop.basis;
      } catch (error) {
        if (
          error instanceof ProviderConfigError ||
          error instanceof ProviderHttpError ||
          error instanceof ProviderRequestError
        ) {
          status = 'unavailable';
          cropBasis = 'unavailable';
          cropHealthScore = null;
        } else {
          throw error;
        }
      }
    }

    const factor = computeGeoCreditFactor(
      {
        plotVerified,
        areaHectares,
        floodBand,
        cropHealthScore,
        plotUpdatedAt: plot?.updatedAt ?? null
      },
      nowIso
    );

    const inputFingerprint = computeInputFingerprint([
      loan.id,
      plot?.id ?? null,
      plot?.updatedAt ?? null,
      areaHectares,
      floodBand,
      floodBasis,
      cropHealthScore,
      cropBasis,
      factor.score
    ]);

    return {
      applicationId: loan.id,
      factorScore: status === 'computed' ? factor.score : null,
      status,
      breakdown: factor.breakdown,
      basis: { flood: floodBasis, crop: cropBasis },
      inputFingerprint,
      computedAt: nowIso
    };
  }

  /**
   * Read-only shadow view for credit officers (admin|lender). Returns the
   * latest persisted shadow score; computes + persists one on first access
   * (the shadow table is the only legal persistence target). Fail-closed:
   * answers 503 when a required live provider is unreachable.
   */
  async getShadowScore(applicationId: string, actor: CreditActor): Promise<GeoCreditShadowScore> {
    this.assertEnabled();
    requireReviewer(actor);
    const loan = await this.loans.getById(applicationId);
    const existing = await this.shadow.findOne({ applicationId: loan.id });
    if (existing) {
      return existing;
    }
    const computed = await this.computeForApplication(loan);
    if (computed.status === 'unavailable') {
      throw new ServiceUnavailableException(
        'Geo verification is unavailable: the configured crop-ml sidecar could not be reached. ' +
          'No shadow score was recorded — try again later.'
      );
    }
    await this.shadow.upsert({ id: newId('gcs'), ...computed });
    return computed;
  }

  /**
   * Batch shadow recompute for open applications (admin). Idempotent per
   * application + input fingerprint: unchanged inputs are skipped, changed
   * inputs append a new row. Per-application failures never abort the batch.
   */
  async recomputeOpenApplications(actor: CreditActor): Promise<GeoShadowRecomputeReport> {
    this.assertEnabled();
    requireAdmin(actor);
    const all = await this.loans.all();
    const open = all.filter((loan) => GEO_SHADOW_OPEN_STATUSES.includes(loan.status));
    const report: GeoShadowRecomputeReport = {
      mode: this.mode(),
      applications: open.length,
      recomputed: 0,
      skipped: 0,
      unavailable: 0,
      failed: 0,
      computedAt: new Date().toISOString()
    };
    for (const loan of open) {
      try {
        const computed = await this.computeForApplication(loan);
        if (computed.status === 'unavailable') {
          report.unavailable += 1;
          continue;
        }
        const unchanged = await this.shadow.findOne({
          applicationId: loan.id,
          inputFingerprint: computed.inputFingerprint
        });
        if (unchanged) {
          report.skipped += 1;
          continue;
        }
        await this.shadow.upsert({ id: newId('gcs'), ...computed });
        report.recomputed += 1;
      } catch {
        report.failed += 1;
      }
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.geo_shadow.recomputed',
      entityType: 'geo_credit_shadow_scores',
      entityId: 'batch',
      metadata: { ...report }
    });
    return report;
  }
}
