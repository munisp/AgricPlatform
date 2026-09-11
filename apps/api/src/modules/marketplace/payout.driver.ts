import { ServiceUnavailableException } from '@nestjs/common';
import type { EscrowPayoutKind } from '@agric-platform/shared';
import { ProviderConfigError } from '../integrations/drivers/http.js';

/**
 * Escrow payout driver port (Stage 23: escrow residual — provider-backed
 * release/refund rails). Money OUT of escrow (release to the seller, refund
 * to the buyer) goes through this port; the escrow service records every
 * attempt (idempotency key, integer kobo amount, provider reference, status)
 * and only transitions the escrow to a terminal state after the driver
 * reports success.
 *
 * ESCROW_PAYOUT_DRIVER=stub (default outside production): deterministic,
 * clearly labelled local driver — it "succeeds" without moving real money
 * and every result is stamped `basis: 'stub'`. It exists so development and
 * CI can exercise the full rail; it is NOT a disbursement.
 *
 * PRODUCTION fail-closed rule (mirrors the Stage 22 use-time 503 precedent
 * for deposit verification — deliberately NOT a boot-fatal guard so the CI
 * smoke-test environment keeps booting): when the driver resolves to stub
 * or is unset in production, EscrowService refuses release/refund with 503
 * at use-time and records NOTHING.
 *
 * ESCROW_PAYOUT_DRIVER=live: reserved for a PSSP disbursement integration
 * (transfer recipients / payout accounts). Requires PAYOUT_PROVIDER_URL +
 * PAYOUT_PROVIDER_API_KEY + PAYOUT_PROVIDER_SIGNING_SECRET; the factory
 * rejects missing config and published/default/short secrets (fail closed).
 * Until a vendor client lands, every payout call answers 503
 * "not yet integrated" — the driver NEVER silently succeeds.
 *
 * EXTERNAL GATE: PSSP disbursement API contract (Paystack transfers /
 * Flutterwave payouts) + seller payout-account modelling.
 */

export const ESCROW_PAYOUT_DRIVER = Symbol('ESCROW_PAYOUT_DRIVER');

export interface EscrowPayoutCommand {
  escrowId: string;
  orderId: string;
  kind: EscrowPayoutKind;
  /** Integer kobo; never a float. */
  amountKobo: number;
  /** Deterministic per (escrow, kind); the provider must treat it idempotently. */
  idempotencyKey: string;
  /** Buyer-deposit provider reference held on the escrow record, when any. */
  depositProviderReference?: string;
}

export interface EscrowPayoutResult {
  /** Provider-side payout/transfer reference for reconciliation. */
  providerReference: string;
  /** Honest provenance label. */
  basis: 'stub' | 'live';
}

export interface EscrowPayoutDriverPort {
  readonly name: 'stub' | 'live';
  payout(command: EscrowPayoutCommand): Promise<EscrowPayoutResult>;
}

/**
 * Deterministic labelled stub: "succeeds" locally with a reference derived
 * from the idempotency key so replays converge. Records/moves nothing
 * outside the process — every result is labelled `basis: 'stub'`.
 */
export class StubEscrowPayoutDriver implements EscrowPayoutDriverPort {
  readonly name = 'stub' as const;

  payout(command: EscrowPayoutCommand): Promise<EscrowPayoutResult> {
    return Promise.resolve({
      providerReference: `stub-payout:${command.idempotencyKey}`,
      basis: 'stub'
    });
  }
}

/**
 * Live driver placeholder: a real PSSP disbursement client is an EXTERNAL
 * GATE (vendor contract + seller payout-account modelling). Config is
 * validated by the factory; every payout call then fails closed with 503 so
 * no deployment can pretend to disburse escrow funds.
 */
export class LiveEscrowPayoutDriver implements EscrowPayoutDriverPort {
  readonly name = 'live' as const;

  constructor(
    private readonly providerUrl: string,
    private readonly apiKey: string,
    private readonly signingSecret: string
  ) {}

  payout(_command: EscrowPayoutCommand): Promise<never> {
    if (!this.providerUrl || !this.apiKey || !this.signingSecret) {
      return Promise.reject(
        new ServiceUnavailableException(
          'ESCROW_PAYOUT_DRIVER=live requires PAYOUT_PROVIDER_URL, PAYOUT_PROVIDER_API_KEY ' +
            'and PAYOUT_PROVIDER_SIGNING_SECRET (fail-closed: no disbursement possible).'
        )
      );
    }
    // No PSSP disbursement client is integrated yet — fail closed rather
    // than silently booking a payout no provider performed.
    return Promise.reject(
      new ServiceUnavailableException(
        'PSSP disbursement API not yet integrated: live escrow payouts fail closed (503) ' +
          'until a vendor client lands. Never silently succeed.'
      )
    );
  }
}

/**
 * Published/default development secrets must never authenticate a live
 * payout rail (mirrors the partner-api dev-secret refusal and the webhook
 * signing-secret doctrine: a guessable secret is worse than none).
 */
const PUBLISHED_PAYOUT_SECRETS: ReadonlySet<string> = new Set([
  'stub',
  'changeme',
  'change-me',
  'password',
  'secret',
  'test',
  'dev',
  'development',
  'payout-dev-secret',
  'dummy'
]);

const MIN_PAYOUT_SECRET_LENGTH = 16;

/** True when a configured live credential is missing, published or too short. */
function isWeakLiveCredential(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length < MIN_PAYOUT_SECRET_LENGTH || PUBLISHED_PAYOUT_SECRETS.has(normalized)
  );
}

export function createEscrowPayoutDriver(
  env: NodeJS.ProcessEnv = process.env
): EscrowPayoutDriverPort {
  const flag = (env.ESCROW_PAYOUT_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = [
      'PAYOUT_PROVIDER_URL',
      'PAYOUT_PROVIDER_API_KEY',
      'PAYOUT_PROVIDER_SIGNING_SECRET'
    ].filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new ProviderConfigError('escrow-payout', missing);
    }
    const weak = ['PAYOUT_PROVIDER_API_KEY', 'PAYOUT_PROVIDER_SIGNING_SECRET'].filter((name) =>
      isWeakLiveCredential(env[name])
    );
    if (weak.length > 0) {
      throw new ProviderConfigError(
        'escrow-payout',
        weak.map(
          (name) =>
            `${name} (published/default/under ${MIN_PAYOUT_SECRET_LENGTH} chars — refusing to authenticate a live payout rail with a guessable credential)`
        )
      );
    }
    return new LiveEscrowPayoutDriver(
      env.PAYOUT_PROVIDER_URL!,
      env.PAYOUT_PROVIDER_API_KEY!,
      env.PAYOUT_PROVIDER_SIGNING_SECRET!
    );
  }
  // stub (or unset): deterministic labelled development driver. In
  // production this is intentionally still returned — EscrowService refuses
  // to run money-out transitions through it at use-time (503, nothing
  // recorded), keeping the failure lazy instead of boot-fatal.
  return new StubEscrowPayoutDriver();
}
