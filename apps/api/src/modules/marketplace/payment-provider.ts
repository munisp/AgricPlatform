/**
 * Marketplace payment provider (Stage 22, audit C2): adapts the wave-P1
 * PaymentDriver (Paystack primary / Flutterwave fallback, naira at the
 * driver boundary) to the escrow PaymentProviderPort (integer kobo).
 *
 * Verify-before-credit: the deposit_paid order transition must carry a
 * buyer-supplied payment reference that is verified with the provider here
 * (status success AND exact amount match in kobo) before escrow is held.
 *
 * Hold semantics: the PSSPs expose no separate "hold" API — the deposit is
 * already captured by the verified charge — so hold() attaches no
 * providerReference and release/refund stay on the declarative local path
 * until the disbursement rail (transfer recipients / seller payout
 * accounts) is modelled. release()/refund() therefore fail loudly: they are
 * unreachable while hold() attaches no providerReference.
 */
import type {
  PaymentHoldCommand,
  PaymentProviderPort,
  PaymentProviderResult,
  PaymentVerificationResult
} from '@agric-platform/shared';
import {
  createPaymentDriver,
  type PaymentDriver
} from '../integrations/drivers/payments.drivers.js';

export class DriverPaymentProvider implements PaymentProviderPort {
  readonly name: string;

  constructor(private readonly driver: PaymentDriver) {
    this.name = driver.name;
  }

  async verify(reference: string): Promise<PaymentVerificationResult> {
    const verification = await this.driver.verifyTransaction(reference);
    return {
      reference: verification.reference,
      status: verification.status,
      // Drivers return naira at the port boundary; assert in kobo.
      amountKobo: Math.round(verification.amountNaira * 100),
      providerReference: verification.providerRef
    };
  }

  async hold(_command: PaymentHoldCommand): Promise<PaymentProviderResult> {
    // Funds were already captured by the verified charge; the escrow record
    // tracks the hold locally. No providerReference is attached, so the
    // release/refund paths below stay unreachable (declarative local
    // transitions until the disbursement rail is wired).
    return {};
  }

  async release(providerReference: string): Promise<void> {
    throw new Error(
      `Payment provider '${this.name}' has no disbursement rail for release ` +
        `(${providerReference}); seller transfers require payout-account modelling`
    );
  }

  async refund(providerReference: string): Promise<void> {
    throw new Error(
      `Payment provider '${this.name}' refund rail is not wired (${providerReference}); ` +
        'refunds stay on the declarative local path'
    );
  }
}

/**
 * Resolves the marketplace payment provider from the environment, mirroring
 * the integrations adapter resolution (PAYMENT_DRIVER flag, paystack
 * primary / flutterwave fallback, credential-driven sandbox default):
 *
 * - PAYMENT_DRIVER=stub (or no flag and no credentials) → undefined; the
 *   declarative deposit path is then a NON-production convenience only
 *   (MarketplaceService refuses deposit_paid in production).
 * - PAYMENT_DRIVER=production|sandbox → a live driver is mandatory:
 *   paystack when PAYSTACK_SECRET_KEY is set (or no flutterwave key),
 *   otherwise flutterwave; createPaymentDriver fails closed
 *   (ProviderConfigError) when the chosen credentials are missing.
 * - No flag + credentials present → credential-driven sandbox default.
 */
export function createMarketplacePaymentProvider(
  env: NodeJS.ProcessEnv = process.env
): PaymentProviderPort | undefined {
  const flag = env.PAYMENT_DRIVER ?? env.PAYSTACK_DRIVER ?? env.FLUTTERWAVE_DRIVER;
  if (flag === 'stub') {
    return undefined;
  }
  if (flag === 'production' || flag === 'sandbox') {
    const provider = env.PAYSTACK_SECRET_KEY || !env.FLUTTERWAVE_SECRET_KEY ? 'paystack' : 'flutterwave';
    return new DriverPaymentProvider(createPaymentDriver(provider, env));
  }
  if (env.PAYSTACK_SECRET_KEY) {
    return new DriverPaymentProvider(createPaymentDriver('paystack', env));
  }
  if (env.FLUTTERWAVE_SECRET_KEY) {
    return new DriverPaymentProvider(createPaymentDriver('flutterwave', env));
  }
  return undefined;
}
