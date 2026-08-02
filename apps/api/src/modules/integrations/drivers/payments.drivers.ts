/**
 * Payment drivers (wave P1): Paystack primary PSSP and Flutterwave
 * fallback rail, behind one PaymentDriver port (docs/integration-matrix.md
 * M7/J2). Covers transaction initialise/verify, refunds, transfers
 * (escrow release rail) and webhook signature verification. Amounts are
 * naira at the port boundary; each driver converts to provider units
 * (Paystack kobo) internally. The shared HMAC-SHA256 webhook path in
 * IntegrationsService stays the default; the verify*Signature helpers here
 * implement each provider's native scheme for direct endpoint use.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpJson, requireEnv } from './http.js';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com';

export type PaymentStatus = 'success' | 'pending' | 'failed';

export interface InitializeTransactionInput {
  /** Whole naira; drivers convert to provider minor units. */
  amountNaira: number;
  email: string;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface InitializedTransaction {
  reference: string;
  authorizationUrl?: string;
  providerRef: string;
}

export interface PaymentVerification {
  reference: string;
  status: PaymentStatus;
  amountNaira: number;
  paidAt?: string;
  providerRef: string;
}

export interface RefundResult {
  providerRef: string;
  status: PaymentStatus;
}

export interface TransferInput {
  amountNaira: number;
  /** Paystack recipient code, or Flutterwave `bank:account` pair. */
  recipient: string;
  reference: string;
  reason?: string;
}

export interface TransferResult {
  providerRef: string;
  status: PaymentStatus;
}

export interface PaymentDriver {
  readonly name: 'paystack' | 'flutterwave';
  initializeTransaction(input: InitializeTransactionInput): Promise<InitializedTransaction>;
  verifyTransaction(reference: string): Promise<PaymentVerification>;
  refund(reference: string, amountNaira?: number): Promise<RefundResult>;
  /** Escrow release / disbursement rail. */
  transfer(input: TransferInput): Promise<TransferResult>;
}

/** Constant-time hex digest comparison. */
function safeEqualHex(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Paystack signs webhooks with HMAC-SHA512 over the raw body (secret key). */
export function verifyPaystackSignature(
  rawBody: Buffer,
  secretKey: string,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  return safeEqualHex(signature, expected);
}

/** Flutterwave sends a static `verif-hash` header equal to the configured hash. */
export function verifyFlutterwaveSignature(
  configuredHash: string,
  verifHashHeader: string | undefined
): boolean {
  if (!verifHashHeader) return false;
  return safeEqualHex(verifHashHeader, configuredHash);
}

interface PaystackEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

export class PaystackPaymentDriver implements PaymentDriver {
  readonly name = 'paystack' as const;

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string = PAYSTACK_BASE_URL
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.secretKey}` };
  }

  async initializeTransaction(input: InitializeTransactionInput): Promise<InitializedTransaction> {
    const response = await httpJson<
      PaystackEnvelope<{ authorization_url?: string; reference?: string; access_code?: string }>
    >(this.name, `${this.baseUrl}/transaction/initialize`, {
      headers: this.headers(),
      body: {
        amount: Math.round(input.amountNaira * 100),
        email: input.email,
        reference: input.reference,
        currency: 'NGN',
        ...(input.metadata ? { metadata: input.metadata } : {})
      }
    });
    return {
      reference: response.data?.reference ?? input.reference,
      authorizationUrl: response.data?.authorization_url,
      providerRef: response.data?.access_code ?? input.reference
    };
  }

  async verifyTransaction(reference: string): Promise<PaymentVerification> {
    const response = await httpJson<
      PaystackEnvelope<{ status?: string; amount?: number; paid_at?: string; id?: number }>
    >(this.name, `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: this.headers()
    });
    const status = response.data?.status;
    return {
      reference,
      status: status === 'success' ? 'success' : status === 'failed' || status === 'abandoned' ? 'failed' : 'pending',
      amountNaira: (response.data?.amount ?? 0) / 100,
      paidAt: response.data?.paid_at,
      providerRef: String(response.data?.id ?? reference)
    };
  }

  async refund(reference: string, amountNaira?: number): Promise<RefundResult> {
    const response = await httpJson<PaystackEnvelope<{ id?: number; status?: string }>>(
      this.name,
      `${this.baseUrl}/refund`,
      {
        headers: this.headers(),
        body: {
          transaction: reference,
          ...(amountNaira !== undefined ? { amount: Math.round(amountNaira * 100) } : {})
        }
      }
    );
    return {
      providerRef: String(response.data?.id ?? reference),
      status: response.data?.status === 'processed' ? 'success' : 'pending'
    };
  }

  /** Transfers require a pre-created transfer recipient on the account. */
  async transfer(input: TransferInput): Promise<TransferResult> {
    const response = await httpJson<PaystackEnvelope<{ transfer_code?: string; status?: string }>>(
      this.name,
      `${this.baseUrl}/transfer`,
      {
        headers: this.headers(),
        body: {
          source: 'balance',
          amount: Math.round(input.amountNaira * 100),
          recipient: input.recipient,
          reference: input.reference,
          reason: input.reason ?? 'AgricPlatform escrow release'
        }
      }
    );
    const status = response.data?.status;
    return {
      providerRef: response.data?.transfer_code ?? input.reference,
      status: status === 'success' ? 'success' : status === 'failed' || status === 'reversed' ? 'failed' : 'pending'
    };
  }
}

export class FlutterwavePaymentDriver implements PaymentDriver {
  readonly name = 'flutterwave' as const;

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string = FLUTTERWAVE_BASE_URL
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.secretKey}` };
  }

  async initializeTransaction(input: InitializeTransactionInput): Promise<InitializedTransaction> {
    const response = await httpJson<{ status?: string; data?: { link?: string; id?: number } }>(
      this.name,
      `${this.baseUrl}/v3/payments`,
      {
        headers: this.headers(),
        body: {
          tx_ref: input.reference,
          amount: input.amountNaira,
          currency: 'NGN',
          customer: { email: input.email },
          ...(input.metadata ? { meta: input.metadata } : {})
        }
      }
    );
    return {
      reference: input.reference,
      authorizationUrl: response.data?.link,
      providerRef: String(response.data?.id ?? input.reference)
    };
  }

  async verifyTransaction(reference: string): Promise<PaymentVerification> {
    const response = await httpJson<{
      status?: string;
      data?: { status?: string; amount?: number; date_created?: string; id?: number };
    }>(this.name, `${this.baseUrl}/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: this.headers()
    });
    const status = response.data?.status;
    return {
      reference,
      status: status === 'successful' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      amountNaira: response.data?.amount ?? 0,
      paidAt: response.data?.date_created,
      providerRef: String(response.data?.id ?? reference)
    };
  }

  async refund(reference: string, amountNaira?: number): Promise<RefundResult> {
    // Flutterwave refunds are keyed by the numeric transaction id; callers
    // pass the providerRef captured at verify time.
    const response = await httpJson<{ status?: string; data?: { id?: number; status?: string } }>(
      this.name,
      `${this.baseUrl}/v3/transactions/${encodeURIComponent(reference)}/refund`,
      {
        headers: this.headers(),
        body: amountNaira !== undefined ? { amount: amountNaira } : {}
      }
    );
    return {
      providerRef: String(response.data?.id ?? reference),
      status: response.data?.status === 'completed' ? 'success' : 'pending'
    };
  }

  /** `recipient` is `bankCode:accountNumber` for the fallback rail. */
  async transfer(input: TransferInput): Promise<TransferResult> {
    const [accountBank, accountNumber] = input.recipient.split(':');
    if (!accountBank || !accountNumber) {
      throw new Error("Flutterwave transfer recipient must be 'bankCode:accountNumber'");
    }
    const response = await httpJson<{ status?: string; data?: { id?: number; status?: string } }>(
      this.name,
      `${this.baseUrl}/v3/transfers`,
      {
        headers: this.headers(),
        body: {
          account_bank: accountBank,
          account_number: accountNumber,
          amount: input.amountNaira,
          currency: 'NGN',
          reference: input.reference,
          narration: input.reason ?? 'AgricPlatform escrow release'
        }
      }
    );
    const status = response.data?.status;
    return {
      providerRef: String(response.data?.id ?? input.reference),
      status: status === 'SUCCESSFUL' ? 'success' : status === 'FAILED' ? 'failed' : 'pending'
    };
  }
}

/** Builds the live payment driver for the requested provider; fails closed. */
export function createPaymentDriver(
  provider: 'paystack' | 'flutterwave',
  env: NodeJS.ProcessEnv = process.env
): PaymentDriver {
  return provider === 'paystack'
    ? new PaystackPaymentDriver(requireEnv('paystack', env, ['PAYSTACK_SECRET_KEY']))
    : new FlutterwavePaymentDriver(requireEnv('flutterwave', env, ['FLUTTERWAVE_SECRET_KEY']));
}
