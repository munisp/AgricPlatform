/**
 * Transactional email drivers (wave P1): Mailgun primary, SendGrid as the
 * alternate provider behind the same port (docs/integration-matrix.md).
 * Stub stays default; the factory fails closed when EMAIL_DRIVER is live
 * but neither provider is fully configured.
 */
import type { DeliveryResult, IntegrationDriver } from '../adapters.js';
import { httpJson, missingEnv, ProviderConfigError } from './http.js';

const MAILGUN_BASE_URL = 'https://api.mailgun.net';
const SENDGRID_BASE_URL = 'https://api.sendgrid.com';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Overrides the provider default sender (EMAIL_FROM). */
  from?: string;
}

export interface EmailDriver {
  readonly name: 'mailgun' | 'sendgrid';
  send(message: EmailMessage): Promise<DeliveryResult>;
}

interface MailgunSendResponse {
  id?: string;
  message?: string;
}

export class MailgunEmailDriver implements EmailDriver {
  readonly name = 'mailgun' as const;

  constructor(
    private readonly apiKey: string,
    private readonly domain: string,
    private readonly defaultFrom: string,
    private readonly driver: IntegrationDriver = 'production',
    private readonly baseUrl: string = MAILGUN_BASE_URL
  ) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const form: Record<string, string> = {
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.text
    };
    if (message.html) {
      form.html = message.html;
    }
    const response = await httpJson<MailgunSendResponse>(
      this.name,
      `${this.baseUrl}/v3/${this.domain}/messages`,
      {
        form,
        headers: {
          authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}`
        }
      }
    );
    return {
      delivered: true,
      provider: 'mailgun',
      driver: this.driver,
      providerRef: response.id ?? `mailgun-${Date.now()}`,
      note: 'Mailgun message queued'
    };
  }
}

interface SendGridSendResponse {
  // SendGrid returns 202 with an empty body; the id arrives via header, but
  // the sandbox echoes errors in the body. Accept either.
  id?: string;
}

export class SendGridEmailDriver implements EmailDriver {
  readonly name = 'sendgrid' as const;

  constructor(
    private readonly apiKey: string,
    private readonly defaultFrom: string,
    private readonly driver: IntegrationDriver = 'production',
    private readonly baseUrl: string = SENDGRID_BASE_URL
  ) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const response = await httpJson<SendGridSendResponse>(this.name, `${this.baseUrl}/v3/mail/send`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: message.from ?? this.defaultFrom },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          ...(message.html ? [{ type: 'text/html', value: message.html }] : [])
        ]
      }
    });
    return {
      delivered: true,
      provider: 'sendgrid',
      driver: this.driver,
      providerRef: response?.id ?? `sendgrid-${Date.now()}`,
      note: 'SendGrid message queued'
    };
  }
}

/**
 * Builds the live email driver for a non-stub EMAIL_DRIVER. Mailgun is
 * preferred when fully configured; SendGrid is the alternate. Throws
 * ProviderConfigError when neither is complete.
 */
export function createEmailDriver(
  env: NodeJS.ProcessEnv = process.env,
  driver: IntegrationDriver = 'production'
): EmailDriver {
  const defaultFrom = env.EMAIL_FROM ?? 'no-reply@agricplatform.ng';
  const mailgunMissing = missingEnv(env, ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN']);
  if (mailgunMissing.length === 0) {
    return new MailgunEmailDriver(
      env.MAILGUN_API_KEY as string,
      env.MAILGUN_DOMAIN as string,
      defaultFrom,
      driver
    );
  }
  if (env.SENDGRID_API_KEY) {
    return new SendGridEmailDriver(env.SENDGRID_API_KEY, defaultFrom, driver);
  }
  throw new ProviderConfigError(
    'email',
    mailgunMissing.length <= 1 ? mailgunMissing : [...mailgunMissing, 'SENDGRID_API_KEY']
  );
}
