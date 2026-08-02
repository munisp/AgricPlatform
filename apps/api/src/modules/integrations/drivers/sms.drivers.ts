/**
 * Live SMS drivers (wave P1): Termii primary with a Twilio fallback rail
 * (docs/integration-matrix.md). The stub stays the default driver; these
 * classes are only constructed when SMS_DRIVER is sandbox/production, and
 * the factory fails closed with ProviderConfigError when the required
 * credentials are absent.
 */
import type { DeliveryResult, IntegrationDriver } from '../adapters.js';
import { httpJson, missingEnv, ProviderConfigError, type HttpRequestOptions } from './http.js';

export interface SmsSendInput {
  to: string;
  message: string;
}

export interface SmsDriver {
  readonly name: 'termii' | 'twilio';
  /** Plain transactional SMS. */
  sendSms(input: SmsSendInput): Promise<DeliveryResult>;
  /** One-time-pin message over the provider's OTP endpoint where available. */
  sendOtp(to: string, pin: string): Promise<DeliveryResult>;
}

const TERMII_BASE_URL = 'https://api.ng.termii.com';
const TWILIO_BASE_URL = 'https://api.twilio.com/2010-04-01';

interface TermiiMessageResponse {
  message_id?: string;
  messageId?: string;
  code?: string;
  message?: string;
}

/** Termii REST API: messaging + OTP endpoints. */
export class TermiiSmsDriver implements SmsDriver {
  readonly name = 'termii' as const;

  constructor(
    private readonly apiKey: string,
    private readonly senderId: string,
    private readonly driver: IntegrationDriver = 'production',
    private readonly baseUrl: string = TERMII_BASE_URL
  ) {}

  async sendSms(input: SmsSendInput): Promise<DeliveryResult> {
    const response = await httpJson<TermiiMessageResponse>(this.name, `${this.baseUrl}/api/sms/send`, {
      body: {
        api_key: this.apiKey,
        to: input.to,
        from: this.senderId,
        sms: input.message,
        type: 'plain',
        channel: 'generic'
      }
    });
    return this.result(response, 'Termii SMS accepted for delivery');
  }

  async sendOtp(to: string, pin: string): Promise<DeliveryResult> {
    const response = await httpJson<TermiiMessageResponse>(this.name, `${this.baseUrl}/api/sms/otp/send`, {
      body: {
        api_key: this.apiKey,
        message_type: 'NUMERIC',
        to,
        from: this.senderId,
        channel: 'generic',
        pin_attempts: 3,
        pin_time_to_live: 10,
        pin_length: pin.length,
        pin_placeholder: '< pin >',
        message_text: `Your AgricPlatform verification code is < pin >`,
        pin
      }
    });
    return this.result(response, 'Termii OTP accepted for delivery');
  }

  private result(response: TermiiMessageResponse, note: string): DeliveryResult {
    return {
      delivered: true,
      provider: 'termii',
      driver: this.driver,
      providerRef: response.message_id ?? response.messageId ?? `termii-${Date.now()}`,
      note
    };
  }
}

interface TwilioMessageResponse {
  sid?: string;
  status?: string;
}

/** Twilio fallback rail (deliverability backup per integration matrix). */
export class TwilioSmsDriver implements SmsDriver {
  readonly name = 'twilio' as const;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
    private readonly driver: IntegrationDriver = 'production',
    private readonly baseUrl: string = TWILIO_BASE_URL
  ) {}

  private options(form: Record<string, string>): HttpRequestOptions {
    return {
      form,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`
      }
    };
  }

  async sendSms(input: SmsSendInput): Promise<DeliveryResult> {
    const response = await httpJson<TwilioMessageResponse>(
      this.name,
      `${this.baseUrl}/Accounts/${this.accountSid}/Messages.json`,
      this.options({ To: input.to, From: this.from, Body: input.message })
    );
    return {
      delivered: true,
      provider: 'twilio',
      driver: this.driver,
      providerRef: response.sid ?? `twilio-${Date.now()}`,
      note: 'Twilio SMS accepted for delivery'
    };
  }

  /** Twilio Verify is a separate product; OTP goes out as a plain message here. */
  async sendOtp(to: string, pin: string): Promise<DeliveryResult> {
    return this.sendSms({ to, message: `Your AgricPlatform verification code is ${pin}` });
  }
}

/**
 * Routes through the primary driver and falls back to the secondary rail
 * when the primary raises (deliverability failover, M15). Configuration
 * errors are not retried — they fail closed immediately.
 */
export class FailoverSmsDriver implements SmsDriver {
  readonly name = 'termii' as const;

  constructor(
    private readonly primary: SmsDriver,
    private readonly fallback: SmsDriver
  ) {}

  async sendSms(input: SmsSendInput): Promise<DeliveryResult> {
    try {
      return await this.primary.sendSms(input);
    } catch (error) {
      if (error instanceof ProviderConfigError) throw error;
      return this.fallback.sendSms(input);
    }
  }

  async sendOtp(to: string, pin: string): Promise<DeliveryResult> {
    try {
      return await this.primary.sendOtp(to, pin);
    } catch (error) {
      if (error instanceof ProviderConfigError) throw error;
      return this.fallback.sendOtp(to, pin);
    }
  }
}

/**
 * Builds the live SMS driver for a non-stub SMS_DRIVER. Termii is primary;
 * when TERMII_* is incomplete but the full Twilio triple is present, Twilio
 * serves directly; when both are present, Twilio becomes the failover rail.
 * Throws ProviderConfigError when neither provider is fully configured.
 */
export function createSmsDriver(
  env: NodeJS.ProcessEnv = process.env,
  driver: IntegrationDriver = 'production'
): SmsDriver {
  const twilioFrom = env.TWILIO_FROM_NUMBER ?? env.TWILIO_FROM;
  const termiiMissing = missingEnv(env, ['TERMII_API_KEY', 'TERMII_SENDER_ID']);
  const twilioMissing = [
    ...missingEnv(env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']),
    ...(twilioFrom ? [] : ['TWILIO_FROM_NUMBER'])
  ];

  const termii =
    termiiMissing.length === 0
      ? new TermiiSmsDriver(env.TERMII_API_KEY as string, env.TERMII_SENDER_ID as string, driver)
      : undefined;
  const twilio =
    twilioMissing.length === 0
      ? new TwilioSmsDriver(
          env.TWILIO_ACCOUNT_SID as string,
          env.TWILIO_AUTH_TOKEN as string,
          twilioFrom as string,
          driver
        )
      : undefined;

  if (termii && twilio) {
    return new FailoverSmsDriver(termii, twilio);
  }
  if (termii) return termii;
  if (twilio) return twilio;
  // Fail closed: report the smaller gap so the operator sees the shortest fix.
  throw new ProviderConfigError(
    'sms',
    termiiMissing.length <= twilioMissing.length ? termiiMissing : twilioMissing
  );
}
