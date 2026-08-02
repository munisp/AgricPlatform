/**
 * Input-finance lender bridge client (wave P5a, matrix Phase 3). Pushes an
 * anonymised, consent-gated credit-readiness snapshot to the lender
 * endpoint. The payload carries a salted member reference hash — never a
 * name, phone, NIN or BVN. Inbound loan status/repayment events arrive on
 * the federation webhook and are handled by LenderIntegrationService.
 * Fail closed: a non-stub LENDER_DRIVER without credentials raises
 * ProviderConfigError at construction.
 */
import { httpRequest, requireEnv } from './http.js';

/** Anonymised credit-readiness payload (NDPR minimisation). */
export interface CreditReadinessPush {
  /** SHA-256 member reference (salted); correlates without identity. */
  memberRef: string;
  score: number;
  version: string;
  /** Consent purpose + capture time the lender must honour. */
  consentPurpose: string;
  consentedAt: string;
  computedAt: string;
}

export class LenderClient {
  readonly name = 'lender';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async pushCreditReadiness(payload: CreditReadinessPush): Promise<void> {
    await httpRequest(this.name, `${this.baseUrl.replace(/\/$/, '')}/v1/credit-readiness`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: payload
    });
  }
}

/** True when the lender push may run (flag + credentials present). */
export function lenderDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.LENDER_DRIVER;
  return (
    (flag === 'live' || flag === 'production' || flag === 'sandbox') &&
    Boolean(env.LENDER_BASE_URL && env.LENDER_API_KEY)
  );
}

/** Fail-closed factory; returns undefined while the driver is stub. */
export function createLenderClient(env: NodeJS.ProcessEnv = process.env): LenderClient | undefined {
  const flag = env.LENDER_DRIVER ?? 'stub';
  if (flag === 'stub') {
    return undefined;
  }
  return new LenderClient(
    requireEnv('lender', env, ['LENDER_BASE_URL']),
    requireEnv('lender', env, ['LENDER_API_KEY'])
  );
}
