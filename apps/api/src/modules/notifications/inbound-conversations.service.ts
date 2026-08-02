import { ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { KEY_VALUE_STORE } from '../../database/persistence.tokens.js';
import type { KeyValueStore } from '../../redis/key-value-store.js';
import { AdvisoryService } from '../advisory/advisory.service.js';
import type { WhatsAppInboundMessage } from '../integrations/drivers/whatsapp.drivers.js';
import { Dialog360WhatsAppDriver } from '../integrations/drivers/whatsapp.drivers.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { routeWaMessage, type WaAction, type WaFlow } from './whatsapp-workflows.js';

/** Multi-turn workflow state TTL (matches the idempotency store cadence). */
export const WA_FLOW_TTL_MS = 24 * 60 * 60 * 1000;
/** Pending tap-to-confirm action TTL. */
export const WA_CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;

/** Pending confirmation registered for a notification tap-to-confirm action. */
export interface WaPendingConfirmation {
  kind: 'generic' | 'enrol_course';
  /** Sender phone the confirmation is bound to (E.164 or provider format). */
  phone: string;
  /** generic: reply shown on success. enrol_course: course to enrol in. */
  message?: string;
  courseId?: string;
}

export interface InboundConversationResult {
  from: string;
  reply: string;
  action?: WaAction;
  /** True when the provider message id was already processed (safe replay). */
  duplicate?: boolean;
}

/**
 * Inbound WhatsApp conversation service (wave P5b). Consumes the normalised
 * 360dialog inbound events from wave P1 (the driver class is only used for
 * normalisation — never modified), routes them through the pure workflow
 * machines (whatsapp-workflows.ts), persists multi-turn state in the shared
 * KV store with a 24h TTL and replies via the integrations delivery seam
 * (stub-safe, live when WHATSAPP_DRIVER is configured).
 *
 * Wiring: subscribes to `integration.webhook.received` (published by the
 * integrations webhook controller with the verified payload), so no changes
 * to the driver or controller flow are needed beyond the additive payload.
 */
@Injectable()
export class InboundConversationsService {
  private readonly logger = new Logger(InboundConversationsService.name);

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly users: UsersService,
    private readonly marketplace: MarketplaceService,
    private readonly advisory: AdvisoryService,
    private readonly learning: LearningService,
    private readonly events: DomainEventsService,
    private readonly profiles: ProfilesService,
    @Inject(KEY_VALUE_STORE) private readonly kv: KeyValueStore,
    // Normalisation-only driver instance; no credentials, no network calls.
    @Optional()
    private readonly normalizer: Pick<Dialog360WhatsAppDriver, 'normalizeInboundWebhook'> = new Dialog360WhatsAppDriver(
      '',
      undefined,
      'stub'
    )
  ) {}

  onModuleInit(): void {
    this.events.on('integration.webhook.received', (event) => {
      const payload = event.payload as { provider?: string; payload?: unknown };
      if (payload.provider !== 'whatsapp') {
        return;
      }
      void this.processWebhookPayload(payload.payload).catch((error) =>
        this.logger.warn(`WhatsApp inbound processing failed: ${(error as Error).message}`)
      );
    });
  }

  /** Normalises a verified 360dialog webhook payload and handles its messages. */
  async processWebhookPayload(payload: unknown): Promise<InboundConversationResult[]> {
    return this.handleInbound(this.normalizer.normalizeInboundWebhook(payload));
  }

  /** Registers a pending tap-to-confirm action for a notification (24h TTL). */
  async registerConfirmation(code: string, pending: WaPendingConfirmation): Promise<void> {
    await this.kv.set(this.confirmKey(code), JSON.stringify(pending), WA_CONFIRM_TTL_MS);
  }

  /** Handles normalised inbound messages; provider-message-id idempotent. */
  async handleInbound(messages: WhatsAppInboundMessage[]): Promise<InboundConversationResult[]> {
    const results: InboundConversationResult[] = [];
    for (const message of messages) {
      const fresh = await this.kv.setNx(this.msgKey(message.providerMessageId), '1', WA_FLOW_TTL_MS);
      if (!fresh) {
        results.push({ from: message.from, reply: '', duplicate: true });
        continue;
      }
      const stored = await this.kv.get(this.flowKey(message.from));
      const flow = stored ? (JSON.parse(stored) as WaFlow) : undefined;
      const turn = routeWaMessage(flow, message.text ?? '');
      if (turn.flow) {
        await this.kv.set(this.flowKey(message.from), JSON.stringify(turn.flow), WA_FLOW_TTL_MS);
      } else {
        await this.kv.delete(this.flowKey(message.from));
      }
      const reply = turn.action
        ? await this.executeAction(message.from, turn.action, turn.reply)
        : turn.reply;
      if (reply) {
        await this.integrations.deliverMessage('whatsapp', { to: message.from, text: reply });
      }
      results.push({ from: message.from, reply, action: turn.action });
    }
    return results;
  }

  /** Executes a workflow action and returns the final reply text. */
  private async executeAction(from: string, action: WaAction, fallback: string): Promise<string> {
    try {
      switch (action.type) {
        case 'create_listing':
          return await this.createListing(from, action);
        case 'advisory_request':
          return await this.advisoryReply(action);
        case 'confirm_action':
          return await this.confirmAction(from, action.code);
      }
    } catch (error) {
      this.logger.warn(`WhatsApp action ${action.type} failed: ${(error as Error).message}`);
      return 'Sorry, that did not go through. Please try again or reply MENU.';
    }
    return fallback;
  }

  private async createListing(
    from: string,
    action: Extract<WaAction, { type: 'create_listing' }>
  ): Promise<string> {
    const user = await this.resolveUser(from);
    if (!user) {
      return 'We could not match this phone number to an account. Register first (app or USSD), then retry.';
    }
    // LGA is captured in the chat flow (wave P6b); the state comes from the
    // member profile when present so listings are discoverable by state.
    const profile = await this.profiles.get(user.id).catch(() => undefined);
    const listing = await this.marketplace.createListing({
      sellerId: user.id,
      kind: 'produce',
      title: `${action.crop} — ${action.quantityKg} kg`,
      crop: action.crop,
      quantity: action.quantityKg,
      unit: 'kg',
      priceNaira: action.priceNaira,
      location: { state: profile?.location?.state ?? 'unspecified', lga: action.lga }
    });
    return `Listing published (${listing.id}). Buyers can now find your ${action.crop}. Reply MENU for more.`;
  }

  private async advisoryReply(action: Extract<WaAction, { type: 'advisory_request' }>): Promise<string> {
    const items = await this.advisory.list({ crop: action.crop, state: action.state, pageSize: 3 });
    const lines = [`Advisory for ${action.crop} (${action.state}):`];
    if (items.data.length === 0) {
      lines.push('No advisories published yet for this crop/state.');
    } else {
      for (const item of items.data.slice(0, 2)) {
        lines.push(`• ${item.title}: ${item.summary}`);
      }
    }
    try {
      const weather = await this.advisory.weatherFor(action.state);
      lines.push(`Weather: ${weather.temperatureCelsius}C, ${weather.outlook}`);
    } catch {
      // Weather is best-effort context; the advisory answer stands alone.
    }
    const reply = lines.join('\n');
    return reply.length > 500 ? `${reply.slice(0, 497)}…` : reply;
  }

  private async confirmAction(from: string, code: string): Promise<string> {
    // Read-then-delete (not getdel): a wrong-phone attempt must not consume
    // the rightful owner's pending action.
    const stored = await this.kv.get(this.confirmKey(code));
    if (!stored) {
      return 'Unknown or expired confirmation code.';
    }
    const pending = JSON.parse(stored) as WaPendingConfirmation;
    if (pending.phone !== from && pending.phone !== `+${from}`) {
      return 'This confirmation code belongs to a different phone number.';
    }
    await this.kv.delete(this.confirmKey(code));
    if (pending.kind === 'enrol_course') {
      const user = await this.resolveUser(from);
      if (!user) {
        return 'We could not match this phone number to an account. Register first, then retry.';
      }
      try {
        await this.learning.enrol(pending.courseId as string, user.id);
      } catch (error) {
        if (error instanceof ConflictException) {
          return 'You are already enrolled in this course.';
        }
        throw error;
      }
      return `Enrolment confirmed for course ${pending.courseId}.`;
    }
    return pending.message ?? 'Confirmed. Thank you!';
  }

  /** Matches a WhatsApp sender against registered phone identities. */
  private async resolveUser(from: string) {
    return (await this.users.findByPhone(from)) ?? (await this.users.findByPhone(`+${from}`));
  }

  private flowKey(from: string): string {
    return `wa:flow:${from}`;
  }

  private msgKey(providerMessageId: string): string {
    return `wa:msg:${providerMessageId}`;
  }

  private confirmKey(code: string): string {
    return `wa:confirm:${code.toLowerCase()}`;
  }
}
