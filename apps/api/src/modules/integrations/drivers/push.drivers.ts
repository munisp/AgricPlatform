/**
 * OneSignal push driver (wave P1). Stub stays default; constructed only
 * when PUSH_DRIVER is sandbox/production with ONESIGNAL_APP_ID and
 * ONESIGNAL_REST_API_KEY present.
 */
import type { DeliveryResult, IntegrationDriver } from '../adapters.js';
import { httpJson, requireEnv } from './http.js';

const ONESIGNAL_BASE_URL = 'https://onesignal.com';

export interface PushMessage {
  /** External user ids (AgricPlatform member ids) to target. */
  userIds?: string[];
  /** OneSignal segments when broadcasting (e.g. 'Subscribed Users'). */
  segments?: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
}

interface OneSignalResponse {
  id?: string;
  recipients?: number;
  errors?: unknown;
}

export class OneSignalPushDriver {
  readonly name = 'onesignal';

  constructor(
    private readonly appId: string,
    private readonly restApiKey: string,
    private readonly driver: IntegrationDriver = 'production',
    private readonly baseUrl: string = ONESIGNAL_BASE_URL
  ) {}

  async send(message: PushMessage): Promise<DeliveryResult> {
    if (!message.userIds?.length && !message.segments?.length) {
      throw new Error('OneSignal push requires at least one user id or segment');
    }
    const response = await httpJson<OneSignalResponse>(this.name, `${this.baseUrl}/api/v1/notifications`, {
      headers: { authorization: `Basic ${this.restApiKey}` },
      body: {
        app_id: this.appId,
        ...(message.userIds?.length
          ? { include_external_user_ids: message.userIds }
          : { included_segments: message.segments }),
        headings: { en: message.title },
        contents: { en: message.body },
        ...(message.data ? { data: message.data } : {})
      }
    });
    return {
      delivered: true,
      provider: 'onesignal',
      driver: this.driver,
      providerRef: response.id ?? `onesignal-${Date.now()}`,
      note: `OneSignal accepted notification for ${response.recipients ?? 0} recipient(s)`
    };
  }
}

/** Builds the live push driver; fails closed without both OneSignal keys. */
export function createPushDriver(
  env: NodeJS.ProcessEnv = process.env,
  driver: IntegrationDriver = 'production'
): OneSignalPushDriver {
  return new OneSignalPushDriver(
    requireEnv('onesignal', env, ['ONESIGNAL_APP_ID']),
    requireEnv('onesignal', env, ['ONESIGNAL_REST_API_KEY']),
    driver
  );
}
