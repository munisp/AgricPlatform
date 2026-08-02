/**
 * WhatsApp Business API via 360dialog (wave P1): template sends plus
 * inbound webhook normalisation. The stub stays default; this driver is
 * constructed only when WHATSAPP_DRIVER is sandbox/production with
 * WHATSAPP_360DIALOG_API_KEY present.
 */
import type { DeliveryResult, IntegrationDriver } from '../adapters.js';
import { httpJson, requireEnv } from './http.js';

const D360_BASE_URL = 'https://waba.360dialog.io';

export interface WhatsAppTemplateInput {
  to: string;
  /** Approved template name (Meta Business Manager). */
  template: string;
  /** BCP-47 language code, defaults to English. */
  languageCode?: string;
  /** Positional body parameters substituted into {{1}}, {{2}}, … */
  bodyParams?: string[];
}

/** Normalised inbound message extracted from a 360dialog webhook payload. */
export interface WhatsAppInboundMessage {
  providerMessageId: string;
  from: string;
  timestamp: string;
  type: string;
  text?: string;
}

interface D360SendResponse {
  messages?: Array<{ id?: string }>;
}

interface D360WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
  // Sandbox payloads sometimes arrive without the entry/changes envelope.
  messages?: Array<{
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }>;
}

export class Dialog360WhatsAppDriver {
  readonly name = 'whatsapp';

  constructor(
    private readonly apiKey: string,
    /** WABA namespace used for template lookups/reporting. */
    readonly namespace: string | undefined,
    private readonly driver: IntegrationDriver = 'production',
    private readonly baseUrl: string = D360_BASE_URL
  ) {}

  /** Sends a pre-approved template message (Cloud-API-compatible payload). */
  async sendTemplate(input: WhatsAppTemplateInput): Promise<DeliveryResult> {
    const response = await httpJson<D360SendResponse>(this.name, `${this.baseUrl}/v1/messages`, {
      headers: { 'D360-API-KEY': this.apiKey },
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'template',
        template: {
          name: input.template,
          language: { code: input.languageCode ?? 'en' },
          ...(input.bodyParams?.length
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: input.bodyParams.map((text) => ({ type: 'text', text }))
                  }
                ]
              }
            : {})
        }
      }
    });
    return {
      delivered: true,
      provider: 'whatsapp',
      driver: this.driver,
      providerRef: response.messages?.[0]?.id ?? `whatsapp-${Date.now()}`,
      note: '360dialog template message accepted for delivery'
    };
  }

  /** Sends a free-form text message (valid inside the 24h session window). */
  async sendText(input: { to: string; message: string }): Promise<DeliveryResult> {
    const response = await httpJson<D360SendResponse>(this.name, `${this.baseUrl}/v1/messages`, {
      headers: { 'D360-API-KEY': this.apiKey },
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'text',
        text: { body: input.message }
      }
    });
    return {
      delivered: true,
      provider: 'whatsapp',
      driver: this.driver,
      providerRef: response.messages?.[0]?.id ?? `whatsapp-${Date.now()}`,
      note: '360dialog text message accepted for delivery'
    };
  }

  /**
   * Normalises a 360dialog inbound webhook payload into provider-agnostic
   * messages. Unknown entries are skipped; an empty result is a valid
   * outcome for status-only webhooks (delivery receipts).
   */
  normalizeInboundWebhook(payload: unknown): WhatsAppInboundMessage[] {
    const body = (payload ?? {}) as D360WebhookPayload;
    const rawMessages =
      body.entry?.flatMap((entry) => entry.changes ?? []).flatMap((change) => change.value?.messages ?? []) ??
      body.messages ??
      [];
    const normalised: WhatsAppInboundMessage[] = [];
    for (const message of rawMessages) {
      if (!message?.id || !message.from) {
        continue;
      }
      normalised.push({
        providerMessageId: message.id,
        from: message.from,
        timestamp: message.timestamp ?? new Date().toISOString(),
        type: message.type ?? 'unknown',
        text: message.text?.body
      });
    }
    return normalised;
  }
}

/** Builds the live WhatsApp driver; fails closed without the API key. */
export function createWhatsAppDriver(
  env: NodeJS.ProcessEnv = process.env,
  driver: IntegrationDriver = 'production'
): Dialog360WhatsAppDriver {
  const apiKey = requireEnv('whatsapp', env, ['WHATSAPP_360DIALOG_API_KEY']);
  return new Dialog360WhatsAppDriver(apiKey, env.WHATSAPP_360DIALOG_NAMESPACE, driver);
}
