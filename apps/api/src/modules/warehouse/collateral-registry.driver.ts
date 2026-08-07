import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from '../integrations/drivers/http.js';
import { isProduction } from '../../common/auth/auth.config.js';

/**
 * Collateral registry port (wave WAREHOUSE): the external register where a
 * receipt pledge (lien) is recorded so the same grain lot cannot be pledged
 * twice across lenders. Mirrors the repo's fail-closed adapter doctrine.
 *
 * COLLATERAL_REGISTRY_DRIVER=stub (default): DETERMINISTIC, clearly labelled
 * development driver — the registry reference is a stable hash of the
 * pledge inputs, so tests and demos are reproducible. It is NOT a real
 * collateral registry: nothing is recorded externally and the reference is
 * labelled basis:'stub'.
 *
 * COLLATERAL_REGISTRY_DRIVER=live: reserved for the national collateral
 * registry integration (EXTERNAL GATE — vendor contract required). It
 * REQUIRES COLLATERAL_REGISTRY_URL + COLLATERAL_REGISTRY_API_KEY, aborts
 * production boot when they are missing, and fails CLOSED with a provider
 * error (mapped to 503 by the caller) whenever the registry is unreachable —
 * a pledge is NEVER recorded as registered when it was not.
 */

export const COLLATERAL_REGISTRY = Symbol('COLLATERAL_REGISTRY');

export interface CollateralRegistration {
  /** Registry reference (deterministic, STUB-prefixed in stub mode). */
  reference: string;
  /** Honest provenance label: which driver produced this registration. */
  basis: 'stub' | 'live';
}

export interface RegisterCollateralInput {
  pledgeId: string;
  receiptId: string;
  receiptNumber: string;
  lenderId: string;
  borrowerId: string;
  principalKobo: number;
}

export interface CollateralRegistry {
  readonly name: 'stub' | 'live';
  register(input: RegisterCollateralInput): Promise<CollateralRegistration>;
  /** Releases a previous registration; idempotent per reference. */
  release(reference: string): Promise<void>;
}

/** Deterministic labelled fixture: stable reference per pledge id. */
export class StubCollateralRegistry implements CollateralRegistry {
  readonly name = 'stub' as const;

  register(input: RegisterCollateralInput): Promise<CollateralRegistration> {
    const reference = createHash('sha256')
      .update(`warehouse-collateral-stub:${input.pledgeId}:${input.receiptNumber}`)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase();
    return Promise.resolve({ reference: `STUB-${reference}`, basis: 'stub' });
  }

  release(_reference: string): Promise<void> {
    return Promise.resolve();
  }
}

interface LiveRegistrationResponse {
  reference?: string;
}

/** Live registry client. 5s timeout; failures raise provider errors → 503. */
export class HttpCollateralRegistry implements CollateralRegistry {
  readonly name = 'live' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async register(input: RegisterCollateralInput): Promise<CollateralRegistration> {
    const response = await httpJson<LiveRegistrationResponse>(
      'collateral-registry',
      `${this.baseUrl}/v1/registrations`,
      {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: {
          pledgeId: input.pledgeId,
          receiptId: input.receiptId,
          receiptNumber: input.receiptNumber,
          lenderId: input.lenderId,
          borrowerId: input.borrowerId,
          principalKobo: input.principalKobo
        },
        timeoutMs: 5_000
      }
    );
    return { reference: response.reference ?? '', basis: 'live' };
  }

  async release(reference: string): Promise<void> {
    await httpJson('collateral-registry', `${this.baseUrl}/v1/registrations/${reference}/release`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey },
      timeoutMs: 5_000
    });
  }
}

/**
 * Configured-but-incomplete live registry (non-production only): every call
 * fails closed with 503 so no pledge can pretend to be registered.
 */
export class UnconfiguredCollateralRegistry implements CollateralRegistry {
  readonly name = 'live' as const;

  register(): Promise<never> {
    return Promise.reject(
      new ServiceUnavailableException(
        'COLLATERAL_REGISTRY_DRIVER=live requires COLLATERAL_REGISTRY_URL and COLLATERAL_REGISTRY_API_KEY (fail-closed: no collateral registration possible).'
      )
    );
  }

  release(): Promise<never> {
    return Promise.reject(
      new ServiceUnavailableException(
        'COLLATERAL_REGISTRY_DRIVER=live requires COLLATERAL_REGISTRY_URL and COLLATERAL_REGISTRY_API_KEY (fail-closed).'
      )
    );
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured registry. Default is the stub; the live registry
 * requires BOTH COLLATERAL_REGISTRY_URL and COLLATERAL_REGISTRY_API_KEY and
 * aborts production boot when they are missing (fail-closed 503 at call time
 * outside production).
 */
export function createCollateralRegistry(env: NodeJS.ProcessEnv = process.env): CollateralRegistry {
  const flag = (env.COLLATERAL_REGISTRY_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = ['COLLATERAL_REGISTRY_URL', 'COLLATERAL_REGISTRY_API_KEY'].filter(
      (name) => !env[name]
    );
    if (missing.length > 0) {
      if (isProduction(env)) {
        throw new ProviderConfigError('collateral-registry', missing);
      }
      return new UnconfiguredCollateralRegistry();
    }
    const baseUrl = env.COLLATERAL_REGISTRY_URL!.replace(/\/+$/, '');
    return new HttpCollateralRegistry(baseUrl, env.COLLATERAL_REGISTRY_API_KEY!);
  }
  return new StubCollateralRegistry();
}
