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
 * Warehouse-operator certification feed port (wave WAREHOUSE), mirroring the
 * repo's fail-closed adapter doctrine (weather / OTP / flood-ml drivers).
 *
 * WAREHOUSE_CERTIFICATION_DRIVER=stub (default): DETERMINISTIC, clearly
 * labelled development driver — the check outcome is a stable hash of the
 * operator licence reference (or warehouse id), so tests and demos are
 * reproducible. It is NOT a real certification authority: no external call
 * is made and the result is labelled basis:'stub'.
 *
 * WAREHOUSE_CERTIFICATION_DRIVER=live: reserved for the licensed warehouse
 * operator network integration (EXTERNAL GATE). It REQUIRES
 * WAREHOUSE_CERTIFICATION_URL + WAREHOUSE_CERTIFICATION_API_KEY, aborts
 * production boot when they are missing, and fails CLOSED with a provider
 * error (mapped to 503 by the caller) whenever the feed is unreachable —
 * the stub is NEVER silently substituted.
 */

export const WAREHOUSE_CERTIFICATION_FEED = Symbol('WAREHOUSE_CERTIFICATION_FEED');

export interface CertificationCheck {
  /** Outcome of the certification lookup. */
  status: 'certified' | 'pending' | 'suspended';
  /** Honest provenance label: which driver produced this check. */
  basis: 'stub' | 'live';
  /** Registry reference echoed by the feed (deterministic in stub mode). */
  reference: string;
}

export interface WarehouseCertificationFeed {
  readonly name: 'stub' | 'live';
  check(input: { warehouseId: string; operatorLicenseRef?: string }): Promise<CertificationCheck>;
}

/** Deterministic 32-bit FNV-1a hash — stub outcomes are stable per licence. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic labelled fixture: the outcome is a pure function of the
 * licence reference (or warehouse id) — ~3 in 4 licences come back
 * 'certified', the rest stay 'pending'; a licence reference containing the
 * literal 'suspended' always checks as suspended so demos/tests can pin
 * every branch. Re-runs are byte-stable.
 */
export class StubCertificationFeed implements WarehouseCertificationFeed {
  readonly name = 'stub' as const;

  check(input: { warehouseId: string; operatorLicenseRef?: string }): Promise<CertificationCheck> {
    const subject = input.operatorLicenseRef ?? input.warehouseId;
    const reference = createHash('sha256')
      .update(`warehouse-certification-stub:${subject}`)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase();
    const status = subject.toLowerCase().includes('suspended')
      ? ('suspended' as const)
      : fnv1a(`warehouse-certification:${subject}`) % 4 === 0
        ? ('pending' as const)
        : ('certified' as const);
    return Promise.resolve({ status, basis: 'stub', reference: `STUB-${reference}` });
  }
}

interface LiveCertificationResponse {
  status?: 'certified' | 'pending' | 'suspended';
  reference?: string;
}

/**
 * Live feed against the licensed warehouse operator network. 5s timeout; any
 * transport or non-2xx failure raises a provider error which the caller maps
 * to 503 (fail-closed) — no certification is ever assumed.
 */
export class HttpCertificationFeed implements WarehouseCertificationFeed {
  readonly name = 'live' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async check(input: {
    warehouseId: string;
    operatorLicenseRef?: string;
  }): Promise<CertificationCheck> {
    const response = await httpJson<LiveCertificationResponse>(
      'warehouse-certification',
      `${this.baseUrl}/v1/certification-checks`,
      {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: {
          warehouseId: input.warehouseId,
          operatorLicenseRef: input.operatorLicenseRef
        },
        timeoutMs: 5_000
      }
    );
    return {
      status: response.status ?? 'pending',
      basis: 'live',
      reference: response.reference ?? ''
    };
  }
}

/**
 * Configured-but-incomplete live feed (non-production only): every call
 * fails closed with 503 so no deployment can pretend a check happened.
 */
export class UnconfiguredCertificationFeed implements WarehouseCertificationFeed {
  readonly name = 'live' as const;

  check(): Promise<never> {
    return Promise.reject(
      new ServiceUnavailableException(
        'WAREHOUSE_CERTIFICATION_DRIVER=live requires WAREHOUSE_CERTIFICATION_URL and WAREHOUSE_CERTIFICATION_API_KEY (fail-closed: no certification check possible).'
      )
    );
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured feed. Default is the stub; selecting the live feed
 * requires BOTH WAREHOUSE_CERTIFICATION_URL and WAREHOUSE_CERTIFICATION_API_KEY
 * and aborts production boot when they are missing (fail-closed 503 at call
 * time outside production).
 */
export function createCertificationFeed(
  env: NodeJS.ProcessEnv = process.env
): WarehouseCertificationFeed {
  const flag = (env.WAREHOUSE_CERTIFICATION_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = ['WAREHOUSE_CERTIFICATION_URL', 'WAREHOUSE_CERTIFICATION_API_KEY'].filter(
      (name) => !env[name]
    );
    if (missing.length > 0) {
      if (isProduction(env)) {
        throw new ProviderConfigError('warehouse-certification', missing);
      }
      return new UnconfiguredCertificationFeed();
    }
    const baseUrl = env.WAREHOUSE_CERTIFICATION_URL!.replace(/\/+$/, '');
    return new HttpCertificationFeed(baseUrl, env.WAREHOUSE_CERTIFICATION_API_KEY!);
  }
  return new StubCertificationFeed();
}
