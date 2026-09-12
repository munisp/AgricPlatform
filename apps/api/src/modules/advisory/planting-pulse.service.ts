import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { cellToLatLng, latLngToCell } from 'h3-js';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ADVISORY_PULSE_REPOSITORY,
  COMPLIANCE_CONSENT_REPOSITORY,
  FARM_PLOT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AdvisoryDispatch,
  AdvisoryPulseRepository,
  PlotAdvisorySubscription,
  PulseChannel
} from '../../database/repositories/advisory-pulse.repository.js';
import type { ComplianceConsentRepository } from '../../database/repositories/compliance.repository.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type { DailyForecast } from '../integrations/drivers/weather.drivers.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { UsersService } from '../users/users.service.js';
import {
  computePlantingWindow,
  findCropRule,
  renderPulseMessage,
  type PlantingWindowResult
} from './planting-window.js';

/** Rollout flag (DB-backed, default OFF — unknown flag evaluates false). */
export const PLANTING_PULSE_FLAG = 'planting-window-pulse';

/** NDPA consent purpose recorded at subscription time. */
export const PLANTING_PULSE_CONSENT_PURPOSE = 'planting-advisory-notifications';
export const PLANTING_PULSE_POLICY_VERSION = 'planting-pulse-v1';

/** Push cadence: at most one pulse per subscription per week by default. */
export const PULSE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Freshness gate: a forecast older than this never generates an advisory
 * (the 15-minute driver cache keeps real fetches far fresher; this is the
 * belt-and-braces bound, env-overridable for tests).
 */
export const PULSE_FORECAST_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Channels v1 can honour: USSD is pull-only (no push exists) and there is no
 * outbound voice driver in the repo, so subscriptions are limited to
 * sms | ussd | whatsapp (spec's 'voice' stays in the DB CHECK for later).
 */
export const SUBSCRIBABLE_CHANNELS = ['sms', 'ussd', 'whatsapp'] as const;

/** Roles allowed to subscribe on behalf of a plot owner (assisted capture). */
const ASSISTED_ROLES = ['admin', 'enumerator', 'agent'] as const;

export interface SubscribeInput {
  plotId: string;
  channel: PulseChannel;
  crop: string;
  locale?: string;
  /** Version of the consent policy text shown to the farmer. */
  policyVersion?: string;
}

export interface PulsePreview {
  available: boolean;
  basis: 'live' | 'unavailable';
  subscriptionId?: string;
  crop?: string;
  /** Rendered farmer-facing message (only when available). */
  message?: string;
  window?: Record<string, unknown>;
  /** Honest reason when unavailable. */
  reason?: string;
  ruleVersion?: string;
}

export interface DispatchRunSummary {
  scanned: number;
  sent: number;
  failed: number;
  suppressed: number;
  deduped: number;
  skippedFlagOff: number;
}

type ComputeOutcome =
  | {
      status: 'ok';
      result: Extract<PlantingWindowResult, { kind: 'window' | 'wait' }>;
      forecast: DailyForecast;
      body: string;
      bodyHash: string;
    }
  | { status: 'unavailable'; reason: string };

/**
 * Planting-Window Pulse service (Stage 27 Batch 1, innovation 4). Generates
 * per-plot, per-crop season-countdown advisories from the live Open-Meteo
 * driver and pushes them over SMS/WhatsApp; USSD pulls the same preview.
 *
 * FAIL-CLOSED (24-guard doctrine + WP-G15 pattern):
 *  - weather driver stub/unconfigured/outage/stale → NO advisory is sent;
 *    dispatch rows record basis='unavailable' + delivery_status='suppressed',
 *    an audit event is written and the synchronous preview 503s in
 *    production. A fabricated or stale planting window is worse than none.
 *  - SMS/WhatsApp stub drivers report delivered:false honestly, so the
 *    dispatch is recorded 'failed' (retryable next run), never 'delivered'.
 */
@Injectable()
export class PlantingPulseService {
  private readonly logger = new Logger(PlantingPulseService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly integrations: IntegrationsService,
    private readonly users: UsersService,
    private readonly flags: FeatureFlagsService,
    private readonly telemetry: TelemetryService,
    @Optional() private readonly audit: AuditService | undefined,
    @Inject(ADVISORY_PULSE_REPOSITORY) private readonly pulse: AdvisoryPulseRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(COMPLIANCE_CONSENT_REPOSITORY) private readonly consents: ComplianceConsentRepository
  ) {}

  /** POST /api/advisory/subscriptions — farmer or assisted field capture. */
  async subscribe(actor: User | null, input: SubscribeInput): Promise<PlotAdvisorySubscription> {
    const caller = this.requireActor(actor);
    if (!(SUBSCRIBABLE_CHANNELS as readonly string[]).includes(input.channel)) {
      throw new UnprocessableEntityException(
        `Channel '${input.channel}' is not subscribable in v1 (supported: ${SUBSCRIBABLE_CHANNELS.join(', ')})`
      );
    }
    const plot = await this.plots.findById(input.plotId);
    if (!plot) {
      throw new NotFoundException(`Farm plot '${input.plotId}' not found`);
    }
    const assisted = ASSISTED_ROLES.some((role) => caller.roles.includes(role));
    if (plot.ownerUserId !== caller.id && !assisted) {
      throw new ForbiddenException('You may only subscribe plots you own');
    }
    // Fail closed on content: no rule table entry → no subscription, so a
    // typo'd crop never produces an invented window at dispatch time.
    const rule = findCropRule(input.crop);
    if (!rule) {
      throw new UnprocessableEntityException(
        `No planting-window rule for crop '${input.crop}' (CROP_RULE_UNKNOWN)`
      );
    }
    // NDPA consent trail (mirrors the field-agent capture pattern).
    const consent = await this.consents.create({
      id: newId('consent'),
      userId: plot.ownerUserId,
      purpose: PLANTING_PULSE_CONSENT_PURPOSE,
      policyVersion: input.policyVersion ?? PLANTING_PULSE_POLICY_VERSION,
      grantedAt: new Date().toISOString(),
      source: 'advisory-subscription'
    });
    const now = new Date().toISOString();
    const subscription: PlotAdvisorySubscription = {
      id: newId('advsub'),
      plotId: plot.id,
      userId: plot.ownerUserId,
      channel: input.channel,
      crop: rule.crop,
      h3Res9: latLngToCell(plot.centroidLat, plot.centroidLong, 9),
      locale: input.locale ?? 'en',
      consentId: consent.id,
      status: 'active',
      createdAt: now,
      updatedAt: now
    };
    // ConflictException (active duplicate) propagates as a 409.
    const created = await this.pulse.createSubscription(subscription);
    await this.events.publish(
      'advisory.subscription.created',
      {
        subscriptionId: created.id,
        plotId: created.plotId,
        channel: created.channel,
        crop: created.crop
      },
      caller.id
    );
    return created;
  }

  /** DELETE /api/advisory/subscriptions/:id — owner or admin; replay-safe. */
  async unsubscribe(actor: User | null, id: string): Promise<PlotAdvisorySubscription> {
    const caller = this.requireActor(actor);
    const subscription = await this.pulse.getSubscriptionById(id);
    assertSelfOrAdmin(caller, subscription.userId);
    const stopped = await this.pulse.stopSubscription(id);
    await this.audit?.record({
      actorId: caller.id,
      action: 'advisory.subscription.stopped',
      entityType: 'advisory_subscription',
      entityId: id,
      metadata: { plotId: subscription.plotId, channel: subscription.channel }
    });
    return stopped;
  }

  /** GET /api/advisory/subscriptions — the caller's own subscriptions. */
  async listMine(actor: User | null): Promise<PlotAdvisorySubscription[]> {
    const caller = this.requireActor(actor);
    return this.pulse.findSubscriptions({ userId: caller.id });
  }

  /** Dispatch history for one subscription (owner or admin). */
  async dispatches(actor: User | null, id: string): Promise<AdvisoryDispatch[]> {
    const caller = this.requireActor(actor);
    const subscription = await this.pulse.getSubscriptionById(id);
    assertSelfOrAdmin(caller, subscription.userId);
    return this.pulse.dispatchesFor(id);
  }

  /**
   * GET /api/advisory/subscriptions/:id/next — synchronous preview. Fails
   * CLOSED: in production a stub/unavailable/stale weather feed is a 503
   * (never a fabricated window); outside production the response is an
   * honest available:false payload.
   */
  async nextFor(actor: User | null, id: string): Promise<PulsePreview> {
    const caller = this.requireActor(actor);
    const subscription = await this.pulse.getSubscriptionById(id);
    assertSelfOrAdmin(caller, subscription.userId);
    if (subscription.status !== 'active') {
      throw new BadRequestException(`Subscription '${id}' is ${subscription.status}`);
    }
    const outcome = await this.computeForSubscription(subscription);
    if (outcome.status === 'unavailable') {
      if (isProduction()) {
        throw new ServiceUnavailableException(
          `Planting advisory unavailable: ${outcome.reason}. Refusing to fabricate a planting window.`
        );
      }
      return { available: false, basis: 'unavailable', subscriptionId: id, reason: outcome.reason };
    }
    return this.previewFromOutcome(subscription, outcome);
  }

  /**
   * USSD pull path: first active subscription for the user identified by
   * phone. Always returns an honest text payload — USSD sessions must answer
   * with a screen, not an HTTP error.
   */
  async previewForUser(userId: string): Promise<PulsePreview> {
    const subscriptions = await this.pulse.findSubscriptions({ userId, status: 'active' });
    if (subscriptions.length === 0) {
      return { available: false, basis: 'unavailable', reason: 'no_active_subscription' };
    }
    const subscription = subscriptions[0];
    const outcome = await this.computeForSubscription(subscription);
    if (outcome.status === 'unavailable') {
      return {
        available: false,
        basis: 'unavailable',
        subscriptionId: subscription.id,
        reason: outcome.reason
      };
    }
    return this.previewFromOutcome(subscription, outcome);
  }

  /**
   * POST /api/advisory/dispatch/run — one dispatch pass (external
   * scheduler/Temporal step; the API starts no timers of its own). Pushable
   * channels only; USSD is pull-only. Per-subscription flag evaluation keeps
   * percentage rollouts meaningful for a cron caller.
   */
  async runDispatch(actorId = 'advisory-dispatch'): Promise<DispatchRunSummary> {
    const intervalMs = Number(process.env.ADVISORY_PULSE_INTERVAL_MS ?? PULSE_INTERVAL_MS);
    const cutoff = new Date(Date.now() - intervalMs).toISOString();
    const due = await this.pulse.listDueForDispatch(cutoff);
    const summary: DispatchRunSummary = {
      scanned: due.length,
      sent: 0,
      failed: 0,
      suppressed: 0,
      deduped: 0,
      skippedFlagOff: 0
    };
    for (const subscription of due) {
      const flagged = await this.flags.isEnabled(PLANTING_PULSE_FLAG, {
        userId: subscription.userId
      });
      if (!flagged) {
        summary.skippedFlagOff += 1;
        continue;
      }
      await this.dispatchOne(subscription, summary, actorId);
    }
    return summary;
  }

  /** One subscription within a dispatch run; never throws out of the loop. */
  private async dispatchOne(
    subscription: PlotAdvisorySubscription,
    summary: DispatchRunSummary,
    actorId: string
  ): Promise<void> {
    const attributes = { crop: subscription.crop, channel: subscription.channel };
    try {
      const outcome = await this.telemetry.withSpan('advisory.pulse.generate', attributes, () =>
        this.computeForSubscription(subscription)
      );
      if (outcome.status === 'unavailable') {
        await this.suppress(subscription, outcome.reason, 'unavailable', actorId);
        summary.suppressed += 1;
        this.telemetry.increment('advisory.pulses_suppressed_unavailable_total', 1, attributes);
        return;
      }
      if (outcome.result.kind !== 'window') {
        // Honest agronomic negative: live data, no plantable window — nothing
        // to push. Recorded as suppressed with the reason (auditability).
        await this.suppress(
          subscription,
          outcome.result.reason,
          'live',
          actorId,
          outcome.result.ruleVersion
        );
        summary.suppressed += 1;
        this.telemetry.increment('advisory.pulses_no_window_total', 1, attributes);
        return;
      }
      if (await this.pulse.hasDeliveredBody(subscription.id, outcome.bodyHash)) {
        summary.deduped += 1;
        return;
      }
      await this.events.publish(
        'advisory.pulse.generated',
        {
          subscriptionId: subscription.id,
          crop: subscription.crop,
          windowStart: outcome.result.windowStart,
          confidence: outcome.result.confidence,
          ruleVersion: outcome.result.ruleVersion
        },
        actorId
      );
      await this.deliver(subscription, outcome, summary, actorId);
    } catch (error) {
      summary.failed += 1;
      this.logger.warn(
        `pulse dispatch failed for subscription ${subscription.id}: ${(error as Error).message}`
      );
    }
  }

  /** Sends one generated window over the subscription channel. */
  private async deliver(
    subscription: PlotAdvisorySubscription,
    outcome: Extract<ComputeOutcome, { status: 'ok' }>,
    summary: DispatchRunSummary,
    actorId: string
  ): Promise<void> {
    const window = outcome.result as Extract<PlantingWindowResult, { kind: 'window' }>;
    const user = await this.users.findById(subscription.userId);
    if (!user) {
      await this.recordDispatch(subscription, outcome, 'failed', 'subscriber account missing');
      await this.events.publish(
        'advisory.pulse.failed',
        { subscriptionId: subscription.id, reason: 'subscriber_missing' },
        actorId
      );
      summary.failed += 1;
      return;
    }
    if (subscription.channel !== 'sms' && subscription.channel !== 'whatsapp') {
      // Unreachable via subscribe() (voice rejected, USSD is pull-only and
      // excluded from due lists); guard anyway — never claim delivery on a
      // channel with no outbound driver.
      await this.recordDispatch(subscription, outcome, 'failed', 'channel has no outbound driver');
      summary.failed += 1;
      return;
    }
    const result = await this.integrations.deliverMessage(subscription.channel, {
      to: user.phone,
      text: outcome.body,
      subject: 'Planting window'
    });
    if (result.delivered) {
      try {
        await this.recordDispatch(subscription, outcome, 'delivered', result.note);
      } catch (error) {
        if (error instanceof ConflictException) {
          // A concurrent run already delivered this exact window — dedupe.
          summary.deduped += 1;
          return;
        }
        throw error;
      }
      await this.pulse.updateSubscription(subscription.id, {
        lastSentAt: new Date().toISOString(),
        plantingWindow: { ...window } as unknown as Record<string, unknown>,
        updatedAt: new Date().toISOString()
      });
      await this.events.publish(
        'advisory.pulse.delivered',
        {
          subscriptionId: subscription.id,
          channel: subscription.channel,
          providerRef: result.providerRef
        },
        actorId
      );
      summary.sent += 1;
      this.telemetry.increment('advisory.pulses_sent_total', 1, { channel: subscription.channel });
      return;
    }
    // Honest non-delivery (stub driver or provider failure): recorded failed,
    // never delivered; the next run retries (last_sent_at stays untouched).
    await this.recordDispatch(subscription, outcome, 'failed', result.note);
    await this.events.publish(
      'advisory.pulse.failed',
      { subscriptionId: subscription.id, channel: subscription.channel, reason: result.note },
      actorId
    );
    summary.failed += 1;
  }

  /** Audit + suppress (WP-G15 pattern): no send, honest dispatch row, audit event. */
  private async suppress(
    subscription: PlotAdvisorySubscription,
    reason: string,
    basis: 'live' | 'unavailable',
    actorId: string,
    ruleVersion?: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.pulse.recordDispatch({
      id: newId('advdsp'),
      subscriptionId: subscription.id,
      channel: subscription.channel,
      basis,
      deliveryStatus: 'suppressed',
      detail: reason,
      ruleVersion,
      createdAt: now
    });
    await this.audit?.record({
      actorId,
      action: 'advisory.pulse.suppressed',
      entityType: 'advisory_subscription',
      entityId: subscription.id,
      metadata: { reason, basis }
    });
    await this.events.publish(
      'advisory.pulse.suppressed',
      { subscriptionId: subscription.id, reason, basis },
      actorId
    );
  }

  private async recordDispatch(
    subscription: PlotAdvisorySubscription,
    outcome: Extract<ComputeOutcome, { status: 'ok' }>,
    status: 'delivered' | 'failed',
    detail: string
  ): Promise<void> {
    const window = outcome.result as Extract<PlantingWindowResult, { kind: 'window' }>;
    const now = new Date().toISOString();
    await this.pulse.recordDispatch({
      id: newId('advdsp'),
      subscriptionId: subscription.id,
      windowStart: window.windowStart,
      bodyHash: outcome.bodyHash,
      channel: subscription.channel,
      basis: 'live',
      deliveryStatus: status,
      detail,
      ruleVersion: window.ruleVersion,
      createdAt: now,
      sentAt: status === 'delivered' ? now : undefined
    });
  }

  /**
   * Generates the advisory for one subscription. Returns 'unavailable'
   * (with an honest reason) whenever the weather basis is not a fresh live
   * forecast — the caller suppresses rather than fabricates.
   */
  private async computeForSubscription(subscription: PlotAdvisorySubscription): Promise<ComputeOutcome> {
    const provider = this.integrations.weatherProvider();
    if (!provider) {
      return { status: 'unavailable', reason: 'weather driver is stub/unconfigured' };
    }
    const plot = await this.plots.findById(subscription.plotId);
    if (!plot) {
      return { status: 'unavailable', reason: 'plot record missing' };
    }
    // Plot H3 res-9 centroid per spec (subscription stamps it at creation;
    // the raw plot centroid is the fallback for pre-existing rows).
    const [latitude, longitude] = subscription.h3Res9
      ? cellToLatLng(subscription.h3Res9)
      : [plot.centroidLat, plot.centroidLong];
    const started = performance.now();
    let forecast: DailyForecast;
    try {
      forecast = await provider.dailyForecast(latitude, longitude);
    } catch (error) {
      return { status: 'unavailable', reason: `weather fetch failed: ${(error as Error).message}` };
    } finally {
      this.telemetry.record('advisory.weather_fetch_latency_ms', performance.now() - started, {
        crop: subscription.crop
      });
    }
    const maxAgeMs = Number(process.env.ADVISORY_PULSE_FORECAST_MAX_AGE_MS ?? PULSE_FORECAST_MAX_AGE_MS);
    const fetchedAtMs = Date.parse(forecast.fetchedAt);
    if (!Number.isFinite(fetchedAtMs) || Date.now() - fetchedAtMs > maxAgeMs) {
      return { status: 'unavailable', reason: 'stale weather forecast (freshness gate)' };
    }
    const result = computePlantingWindow({
      crop: subscription.crop,
      daily: forecast.daily,
      referenceDate: forecast.daily[0].date
    });
    if (result.kind === 'unknown_crop') {
      // Should be unreachable (validated at subscribe); fail closed anyway.
      return { status: 'unavailable', reason: `no rule for crop '${subscription.crop}'` };
    }
    const body = renderPulseMessage(result, {
      plotName: plot.name,
      locale: subscription.locale,
      forecastDate: forecast.fetchedAt.slice(0, 10)
    });
    return {
      status: 'ok',
      result,
      forecast,
      body,
      bodyHash: createHash('sha256').update(body).digest('hex')
    };
  }

  private previewFromOutcome(
    subscription: PlotAdvisorySubscription,
    outcome: Extract<ComputeOutcome, { status: 'ok' }>
  ): PulsePreview {
    const preview: PulsePreview = {
      available: true,
      basis: 'live',
      subscriptionId: subscription.id,
      crop: subscription.crop,
      message: outcome.body,
      ruleVersion: outcome.result.ruleVersion
    };
    if (outcome.result.kind === 'window') {
      preview.window = { ...outcome.result } as unknown as Record<string, unknown>;
    } else {
      preview.reason = outcome.result.reason;
    }
    return preview;
  }

  private requireActor(actor: User | null): User {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for advisory subscriptions');
    }
    return actor;
  }
}
