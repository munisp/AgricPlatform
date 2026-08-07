/**
 * NDVI evidence-linkage provider port (wave VSLACARBON). Seasonal carbon
 * evidence can OPTIONALLY link a Sentinel-2 NDVI assessment from the
 * crop-ml sidecar (services/crop-ml) — the FIXED contract
 * `POST /v1/crop/assess-plot` documented in services/crop-ml/README.md and
 * already implemented by the credit geo-verification drivers
 * (../credit/geo-verification/crop-intel.drivers.ts). This port delegates
 * to that client so the call pattern never diverges.
 *
 * The STUB provider is the default (CROP_ML_DRIVER unset) and returns a
 * deterministic, clearly-labelled fixture (basis 'stub'). The LIVE provider
 * (CROP_ML_DRIVER=http + CROP_ML_URL) calls the sidecar with a 5s timeout,
 * retries and a circuit breaker. FAIL-CLOSED: when the live provider is
 * configured but unreachable the provider error propagates and the evidence
 * endpoint answers 503 — the stub is NEVER silently substituted.
 */
import {
  createCropIntelClient,
  type CropIntelStatus,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from '../credit/geo-verification/crop-intel.drivers.js';

export interface NdviAssessInput {
  plotId: string;
  season: string;
}

export interface NdviAssessment {
  plotId: string;
  season: string;
  healthScore: number;
  classification: 'normal' | 'delayed' | 'stressed';
  /** Honest provenance label from the provider itself. */
  basis: 'stub' | 'live';
}

export interface NdviProvider {
  readonly name: 'stub' | 'http';
  assess(input: NdviAssessInput): Promise<NdviAssessment>;
  status(): Promise<CropIntelStatus>;
}

/** Wraps the shared crop-intel client (fixed crop-ml contract). */
export class CropMlNdviProvider implements NdviProvider {
  readonly name: 'stub' | 'http';
  private readonly client: ReturnType<typeof createCropIntelClient>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.client = createCropIntelClient(env);
    this.name = this.client.name;
  }

  async assess(input: NdviAssessInput): Promise<NdviAssessment> {
    const assessment = await this.client.assessPlot({
      plotId: input.plotId,
      season: input.season
    });
    return {
      plotId: input.plotId,
      season: input.season,
      healthScore: assessment.healthScore,
      classification: assessment.classification,
      basis: assessment.basis
    };
  }

  status(): Promise<CropIntelStatus> {
    return this.client.status();
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

export function isNdviProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderConfigError ||
    error instanceof ProviderHttpError ||
    error instanceof ProviderRequestError
  );
}

export const NDVI_PROVIDER_TOKEN = Symbol('NDVI_PROVIDER');

export function createNdviProvider(env: NodeJS.ProcessEnv = process.env): NdviProvider {
  return new CropMlNdviProvider(env);
}
