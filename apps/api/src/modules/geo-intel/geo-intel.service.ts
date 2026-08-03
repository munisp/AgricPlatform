import {
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import type { FarmPlot, User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { FarmsService } from '../farms/farms.service.js';
import {
  createFloodRiskDriver,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  type FloodRiskAssessment,
  type FloodRiskDriver
} from './flood-risk.drivers.js';

/** Plots farther than this from a requested point are not auto-attached. */
export const NEAREST_PLOT_MAX_KM = 50;

export interface FloodRiskResult extends FloodRiskAssessment {
  assessedLocation: { latitude: number; longitude: number };
  driver: 'stub' | 'http';
  plot?: { id: string; name: string; distanceKm: number };
}

export interface FloodRiskStatus {
  driver: 'stub' | 'http';
  configured: boolean;
  healthy: boolean;
  /** True only when assessments come from the real flood-ml sidecar. */
  liveInference: boolean;
  detail: string;
}

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(aLat: number, aLong: number, bLat: number, bLong: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLong = (bLong - aLong) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLong / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for geo-intel assessments');
  }
  return actor;
}

/**
 * Flood-risk assessment via the driver port (wave ML). The default stub
 * driver returns a deterministic, clearly-labelled simulated fixture; the
 * http driver calls the OPTIONAL flood-ml sidecar. Fail-closed: when
 * FLOOD_ML_DRIVER=http but the sidecar is unconfigured or unreachable,
 * assessments answer 503 rather than silently falling back to simulated
 * data (an operator asked for live inference; serving the fixture would be
 * fabrication).
 */
@Injectable()
export class GeoIntelService {
  private driver: FloodRiskDriver | undefined;

  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Optional() private readonly farms?: FarmsService
  ) {}

  private resolveDriver(): FloodRiskDriver {
    if (!this.driver) {
      try {
        this.driver = createFloodRiskDriver();
      } catch (error) {
        if (error instanceof ProviderConfigError) {
          throw new ServiceUnavailableException(
            `Flood-risk service is not configured: ${error.message}`
          );
        }
        throw error;
      }
    }
    return this.driver;
  }

  /** Visible for tests: resets the lazily-built driver after env changes. */
  resetDriverForTests(): void {
    this.driver = undefined;
  }

  /** The caller's own plots that carry centroid coordinates. */
  private async ownPlotsWithCoords(actor: User): Promise<FarmPlot[]> {
    if (!this.farms) {
      return [];
    }
    const plots = await this.farms.listPlots(actor, { ownerUserId: actor.id });
    return plots.filter(
      (plot) => typeof plot.centroidLat === 'number' && typeof plot.centroidLong === 'number'
    );
  }

  private nearestPlot(
    plots: readonly FarmPlot[],
    latitude: number,
    longitude: number
  ): { plot: FarmPlot; distanceKm: number } | undefined {
    let best: { plot: FarmPlot; distanceKm: number } | undefined;
    for (const plot of plots) {
      const km = distanceKm(latitude, longitude, plot.centroidLat!, plot.centroidLong!);
      if (!best || km < best.distanceKm) {
        best = { plot, distanceKm: km };
      }
    }
    return best;
  }

  async assessFloodRisk(
    actor: User | null,
    query: { lat?: number; long?: number }
  ): Promise<FloodRiskResult> {
    const caller = requireUser(actor);
    const { lat, long } = query;
    if ((lat === undefined) !== (long === undefined)) {
      throw new BadRequestException('lat and long must be provided together');
    }
    if (lat !== undefined && (lat < -90 || lat > 90)) {
      throw new BadRequestException('lat must be between -90 and 90');
    }
    if (long !== undefined && (long < -180 || long > 180)) {
      throw new BadRequestException('long must be between -180 and 180');
    }

    const plots = await this.ownPlotsWithCoords(caller);

    // Resolve the assessment point: explicit coordinates, otherwise the
    // caller's own plot (nearest/first-registered with a centroid).
    let latitude = lat;
    let longitude = long;
    let plot: FloodRiskResult['plot'];
    if (latitude === undefined || longitude === undefined) {
      if (plots.length === 0) {
        throw new BadRequestException(
          'Provide lat and long, or register a farm plot with coordinates first'
        );
      }
      const target = plots[0];
      latitude = target.centroidLat!;
      longitude = target.centroidLong!;
      plot = { id: target.id, name: target.name, distanceKm: 0 };
    } else {
      const nearest = this.nearestPlot(plots, latitude, longitude);
      if (nearest && nearest.distanceKm <= NEAREST_PLOT_MAX_KM) {
        plot = {
          id: nearest.plot.id,
          name: nearest.plot.name,
          distanceKm: Math.round(nearest.distanceKm * 100) / 100
        };
      }
    }

    const driver = this.resolveDriver();
    let assessment: FloodRiskAssessment;
    try {
      assessment = await driver.assess({ latitude, longitude });
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderRequestError ||
        error instanceof ProviderHttpError
      ) {
        throw new ServiceUnavailableException(
          'Flood-risk assessment is unavailable: the flood-ml sidecar could not be reached. ' +
            'Try again later or contact an administrator.'
        );
      }
      throw error;
    }

    await this.audit.record({
      actorId: caller.id,
      action: 'geo_intel.flood_risk_assessed',
      entityType: 'flood_risk_assessment',
      entityId: plot?.id ?? `${latitude.toFixed(4)},${longitude.toFixed(4)}`,
      metadata: {
        driver: driver.name,
        floodDetected: assessment.floodDetected,
        severity: assessment.severity,
        source: assessment.source
      }
    });
    await this.events.publish(
      'geo_intel.flood_risk.assessed',
      {
        driver: driver.name,
        floodDetected: assessment.floodDetected,
        severity: assessment.severity,
        latitude,
        longitude,
        plotId: plot?.id
      },
      caller.id
    );

    return {
      ...assessment,
      assessedLocation: { latitude, longitude },
      driver: driver.name,
      ...(plot ? { plot } : {})
    };
  }

  /**
   * Honest driver status for ops and the web card: which driver is active,
   * whether the sidecar is configured/reachable, and whether assessments
   * are live model inference or simulated fixtures.
   */
  async floodRiskStatus(actor: User | null): Promise<FloodRiskStatus> {
    requireUser(actor);
    let driver: FloodRiskDriver;
    try {
      driver = this.resolveDriver();
    } catch (error) {
      if (error instanceof ProviderConfigError || error instanceof ServiceUnavailableException) {
        return {
          driver: 'http',
          configured: false,
          healthy: false,
          liveInference: false,
          detail:
            'FLOOD_ML_DRIVER=http is set but FLOOD_ML_URL is missing — flood-risk assessment is disabled until configured.'
        };
      }
      throw error;
    }
    const status = await driver.status();
    return {
      driver: driver.name,
      configured: status.configured,
      healthy: status.healthy,
      liveInference: driver.name === 'http' && status.healthy,
      detail: status.detail
    };
  }
}
