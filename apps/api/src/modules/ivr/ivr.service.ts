import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AdvisoryItem, Profile, User } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  COMMODITY_PRICE_REPOSITORY,
  IVR_CALL_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import type {
  IvrCallRecord,
  IvrCallRepository
} from '../../database/repositories/ivr-call.repository.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { AdvisoryService } from '../advisory/advisory.service.js';
import { LearningService } from '../learning/learning.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import {
  handleIvrTurn,
  initialIvrState,
  type IvrCallState,
  type IvrMenuData
} from './call-flow.js';
import { emptyVoiceXml, renderVoiceXml } from './voice-xml.js';

/** Inactivity window for one IVR call session (AT voice calls are short). */
export const IVR_SESSION_TTL_MS = 10 * 60 * 1000;
/** Default sweep cadence for the expired-call sweeper. */
export const IVR_SWEEP_INTERVAL_MS = 60_000;

const IVR_PROVIDER = 'africastalking-voice';

export type IvrDriverMode = 'stub' | 'sandbox' | 'live';

export interface IvrDriverConfig {
  mode: IvrDriverMode;
  /** True only when a non-stub driver flag AND the AT credentials are set. */
  enabled: boolean;
  missing: string[];
}

/**
 * Fail-closed driver resolution (mirrors the USSD wave P5b pattern, itself
 * the wave P1 adapter pattern): IVR_DRIVER=live|production|sandbox requires
 * AT_API_KEY + AT_USERNAME; anything else (including unset) disables the
 * callback endpoint.
 */
export function resolveIvrDriver(env: NodeJS.ProcessEnv = process.env): IvrDriverConfig {
  const flag = (env.IVR_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag !== 'sandbox' && flag !== 'live' && flag !== 'production') {
    return { mode: 'stub', enabled: false, missing: [] };
  }
  const mode: IvrDriverMode = flag === 'sandbox' ? 'sandbox' : 'live';
  const missing = ['AT_API_KEY', 'AT_USERNAME'].filter((name) => !env[name]);
  return { mode, enabled: missing.length === 0, missing };
}

export interface IvrCallbackInput {
  sessionId: string;
  callerNumber: string;
  /** Latest DTMF input; absent/empty on the opening ring or a timeout. */
  dtmfDigits?: string;
  /** '1' while the call is live, '0' on the final hangup notification. */
  isActive?: string;
}

/** Engine state plus the replay cache persisted in channels.ivr_calls.state. */
interface StoredIvrState {
  engine: IvrCallState;
  /** Last processed dtmfDigits; replays return lastResponse verbatim. */
  lastDigits?: string;
  lastResponse?: string;
}

/**
 * IVR voice channel service (wave P6a). Owns call-session lifecycle
 * (10-minute TTL), idempotent replay on (sessionId, dtmf-history length),
 * menu data gathering and the agent-escalation side effect emitted by the
 * pure call-flow engine (call-flow.ts stays I/O-free and fully unit-tested).
 */
@Injectable()
export class IvrService {
  private readonly logger = new Logger(IvrService.name);
  private timer?: NodeJS.Timeout;
  readonly driverConfig: IvrDriverConfig;

  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly advisory: AdvisoryService,
    private readonly learning: LearningService,
    @Inject(IVR_CALL_REPOSITORY) private readonly calls: IvrCallRepository,
    @Inject(COMMODITY_PRICE_REPOSITORY) private readonly prices: CommodityPriceRepository,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.driverConfig = resolveIvrDriver(env);
    // Fail closed at boot in production: a live/sandbox IVR driver without
    // the Africa's Talking credentials aborts startup (wave P1 pattern).
    if (isProduction() && this.driverConfig.mode !== 'stub' && this.driverConfig.missing.length > 0) {
      throw new ProviderConfigError(IVR_PROVIDER, this.driverConfig.missing);
    }
  }

  onModuleInit(): void {
    if (!this.driverConfig.enabled) {
      return;
    }
    const intervalMs = Number(this.env.IVR_SWEEP_INTERVAL_MS ?? IVR_SWEEP_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.sweepExpiredCalls().catch((error) =>
        this.logger.warn(`IVR call sweep failed: ${(error as Error).message}`)
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Outbound call expiry sweeper: deletes rows past their 10-minute TTL. */
  async sweepExpiredCalls(now: Date = new Date()): Promise<number> {
    return this.calls.deleteExpired(now.toISOString());
  }

  /**
   * Handles one Africa's Talking Voice callback and returns the Voice XML
   * document. Idempotency (sessionId + dtmf-history length): AT Voice posts
   * only the latest dtmfDigits per turn, so a retried POST is byte-identical
   * to a caller pressing the same digit twice in a row — the two are only
   * separable at terminal turns. The replay cache therefore applies once the
   * call has an outcome: any further POST for that sessionId returns the
   * cached terminal response verbatim and never re-runs the escalation side
   * effect or grows the dtmf history. Mid-call turns are a pure function of
   * (state, digits, data), so duplicate processing is side-effect free.
   * A POST without dtmfDigits is the opening ring (or its retry) and always
   * re-issues the welcome menu.
   */
  async handleCallback(input: IvrCallbackInput): Promise<string> {
    const now = Date.now();
    const existing = await this.calls.findById(input.sessionId);
    const live = existing && existing.expiresAt > new Date(now).toISOString();
    const stored = live ? (existing.state as unknown as StoredIvrState) : undefined;

    // Final hangup notification: no actions, keep the record for the sweep.
    if (input.isActive === '0') {
      return emptyVoiceXml();
    }

    // Terminal replay: the call already ended (completed/abandoned/
    // escalated) — return the cached terminal response without advancing.
    if (existing && live && existing.outcome) {
      return stored?.lastResponse ?? emptyVoiceXml();
    }

    // No live session or an opening ring (dtmfDigits absent) → welcome menu.
    // Live session + empty-string digits → the GetDigits timeout lapsed
    // (engine counts a strike).
    const opening = !stored || input.dtmfDigits === undefined;
    const engineState = stored?.engine ?? initialIvrState();
    const digits = opening ? undefined : (input.dtmfDigits ?? '');
    const turn = handleIvrTurn(engineState, digits, await this.menuData(input.callerNumber));
    const response = renderVoiceXml(turn.actions);

    if (turn.effect?.type === 'callback_request') {
      // Agent escalation placeholder: the caller is enqueued on the AT
      // dashboard and the call row is marked `escalated` so support staff
      // can poll channels.ivr_calls for callbacks. Outbound dialling is a
      // provider-side concern (no extra credentials in this wave).
      this.logger.log(`IVR callback requested for ${input.callerNumber} (session ${input.sessionId})`);
    }

    // Cumulative dtmf history: opening ring resets to empty; every input
    // turn appends this turn's digits (terminal replays returned above
    // never append, keeping (sessionId, history-length) stable).
    const previousHistory = existing?.dtmfHistory ?? '';
    const history = opening
      ? ''
      : previousHistory
        ? `${previousHistory}*${digits ?? ''}`
        : (digits ?? '');
    const record: IvrCallRecord = {
      sessionId: input.sessionId,
      callerNumber: input.callerNumber,
      state: {
        engine: turn.state,
        lastDigits: digits,
        lastResponse: response
      } as unknown as Record<string, unknown>,
      currentMenu: turn.state.menu,
      dtmfHistory: history,
      outcome: turn.outcome,
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + IVR_SESSION_TTL_MS).toISOString()
    };
    await this.calls.save(record);
    return response;
  }

  /** Gathers the menu data for one turn (latest price per crop, etc.). */
  private async menuData(callerNumber: string): Promise<IvrMenuData> {
    const user = await this.users.findByPhone(callerNumber);
    const [priceRows, advisoryItems, profile, enrolments] = await Promise.all([
      this.prices.find({}),
      this.advisory.all(),
      this.profileFor(user),
      user ? this.learning.enrolmentsForUser(user.id) : Promise.resolve([])
    ]);

    const latestByCrop = new Map<string, (typeof priceRows)[number]>();
    for (const row of priceRows) {
      const current = latestByCrop.get(row.commodity);
      if (!current || row.observedAt > current.observedAt) {
        latestByCrop.set(row.commodity, row);
      }
    }

    return {
      prices: [...latestByCrop.values()]
        .sort((a, b) => a.commodity.localeCompare(b.commodity))
        .slice(0, 6)
        .map((row) => ({
          crop: row.commodity,
          market: row.market,
          state: row.state,
          priceNgn: row.priceNgn,
          observedAt: row.observedAt
        })),
      advisory: latestAdvisory(advisoryItems, profile?.location.state),
      caller: user
        ? {
            fullName: user.fullName,
            kycTier: user.kycTier,
            profileCompleteness: profile?.completionScore ?? 0,
            enrolments: {
              total: enrolments.length,
              inProgress: enrolments.filter((entry) => entry.status !== 'completed').length,
              completed: enrolments.filter((entry) => entry.status === 'completed').length
            }
          }
        : undefined
    };
  }

  /** Caller profile, when one exists (never lets a missing profile break a call). */
  private async profileFor(user: User | undefined): Promise<Profile | undefined> {
    if (!user) {
      return undefined;
    }
    try {
      return await this.profiles.get(user.id);
    } catch {
      return undefined;
    }
  }
}

/**
 * Latest advisory scoped to the caller's state when known (national
 * fallback), else the latest national advisory. Advisories carry an optional
 * `state`; items without one are national.
 */
export function latestAdvisory(
  items: AdvisoryItem[],
  callerState?: string
): IvrMenuData['advisory'] {
  const byPublishedAt = (a: AdvisoryItem, b: AdvisoryItem) =>
    b.publishedAt.localeCompare(a.publishedAt);
  const national = items.filter((item) => !item.state).sort(byPublishedAt);
  if (callerState) {
    const scoped = items
      .filter((item) => item.state?.toLowerCase() === callerState.toLowerCase())
      .sort(byPublishedAt);
    const best = scoped[0] ?? national[0];
    if (best) {
      return { title: best.title, summary: best.summary, kind: best.kind };
    }
    return undefined;
  }
  const best = national[0];
  return best ? { title: best.title, summary: best.summary, kind: best.kind } : undefined;
}
