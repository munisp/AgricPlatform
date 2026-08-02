import { ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  COMMODITY_PRICE_REPOSITORY,
  USSD_SESSION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import type {
  UssdSessionRecord,
  UssdSessionRepository
} from '../../database/repositories/ussd-session.repository.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { LearningService } from '../learning/learning.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';
import {
  handleUssdTurn,
  initialUssdState,
  type UssdMenuData,
  type UssdSessionState
} from './menu-engine.js';

/** Africa's Talking inactivity window for one USSD session. */
export const USSD_SESSION_TTL_MS = 3 * 60 * 1000;
/** Default sweep cadence for the outbound expiry sweeper. */
export const USSD_SWEEP_INTERVAL_MS = 60_000;

const USSD_PROVIDER = 'africastalking-ussd';

export type UssdDriverMode = 'stub' | 'sandbox' | 'live';

export interface UssdDriverConfig {
  mode: UssdDriverMode;
  /** True only when a non-stub driver flag AND the AT credentials are set. */
  enabled: boolean;
  missing: string[];
}

/**
 * Fail-closed driver resolution (mirrors the wave P1 adapter pattern):
 * USSD_DRIVER=live|production|sandbox requires AT_API_KEY + AT_USERNAME;
 * anything else (including unset) disables the callback endpoint.
 */
export function resolveUssdDriver(env: NodeJS.ProcessEnv = process.env): UssdDriverConfig {
  const flag = (env.USSD_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag !== 'sandbox' && flag !== 'live' && flag !== 'production') {
    return { mode: 'stub', enabled: false, missing: [] };
  }
  const mode: UssdDriverMode = flag === 'sandbox' ? 'sandbox' : 'live';
  const missing = ['AT_API_KEY', 'AT_USERNAME'].filter((name) => !env[name]);
  return { mode, enabled: missing.length === 0, missing };
}

export interface UssdCallbackInput {
  sessionId: string;
  phoneNumber: string;
  /** `*` separated cumulative inputs; '' on the opening dial. */
  text: string;
}

/** Engine state plus the replay cache persisted in channels.ussd_sessions.state. */
interface StoredUssdState {
  engine: UssdSessionState;
  /** Last processed cumulative text; replays return lastResponse verbatim. */
  lastText?: string;
  lastResponse?: string;
}

/**
 * USSD channel service (wave P5b). Owns session lifecycle (3-minute TTL),
 * idempotent replay on (sessionId, cumulative text), menu data gathering and
 * the registration/enrolment side effects emitted by the pure menu engine.
 * The engine itself (menu-engine.ts) stays I/O-free and fully unit-tested.
 */
@Injectable()
export class UssdService {
  private readonly logger = new Logger(UssdService.name);
  private timer?: NodeJS.Timeout;
  readonly driverConfig: UssdDriverConfig;

  constructor(
    private readonly users: UsersService,
    private readonly opportunities: OpportunitiesService,
    private readonly learning: LearningService,
    @Inject(USSD_SESSION_REPOSITORY) private readonly sessions: UssdSessionRepository,
    @Inject(COMMODITY_PRICE_REPOSITORY) private readonly prices: CommodityPriceRepository,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.driverConfig = resolveUssdDriver(env);
    // Fail closed at boot in production: a live/sandbox USSD driver without
    // the Africa's Talking credentials aborts startup (wave P1 pattern).
    if (isProduction() && this.driverConfig.mode !== 'stub' && this.driverConfig.missing.length > 0) {
      throw new ProviderConfigError(USSD_PROVIDER, this.driverConfig.missing);
    }
  }

  onModuleInit(): void {
    if (!this.driverConfig.enabled) {
      return;
    }
    const intervalMs = Number(this.env.USSD_SWEEP_INTERVAL_MS ?? USSD_SWEEP_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.sweepExpiredSessions().catch((error) =>
        this.logger.warn(`USSD session sweep failed: ${(error as Error).message}`)
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Outbound session expiry sweeper: deletes rows past their 3-minute TTL. */
  async sweepExpiredSessions(now: Date = new Date()): Promise<number> {
    return this.sessions.deleteExpired(now.toISOString());
  }

  /**
   * Handles one Africa's Talking callback and returns the full response body
   * (CON/END prefixed, ≤182 chars). Replays of the same sessionId with an
   * identical cumulative `text` return the cached response without
   * re-running side effects (idempotent on sessionId + input length).
   */
  async handleCallback(input: UssdCallbackInput): Promise<string> {
    const now = Date.now();
    const text = input.text ?? '';
    const existing = await this.sessions.findById(input.sessionId);

    if (existing && existing.expiresAt > new Date(now).toISOString()) {
      const stored = existing.state as unknown as StoredUssdState;
      if (stored.lastText === text && stored.lastResponse !== undefined) {
        return stored.lastResponse;
      }
    }

    const expired = !existing || existing.expiresAt <= new Date(now).toISOString();
    const stored = expired ? undefined : (existing.state as unknown as StoredUssdState);
    const engineState = stored?.engine ?? initialUssdState();
    const segment = text.split('*').pop() ?? '';

    const data = await this.menuData();
    const turn = handleUssdTurn(engineState, segment, data);
    let response = turn.response;

    if (turn.effect) {
      response = await this.executeEffect(turn.effect, input.phoneNumber, turn.response);
    }

    const record: UssdSessionRecord = {
      sessionId: input.sessionId,
      phone: input.phoneNumber,
      msisdn: input.phoneNumber,
      state: {
        engine: turn.state,
        lastText: text,
        lastResponse: response
      } as unknown as Record<string, unknown>,
      currentMenu: turn.state.menu,
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      expiresAt: new Date(now + USSD_SESSION_TTL_MS).toISOString()
    };
    await this.sessions.save(record);
    return response;
  }

  /** Executes a registration/enrolment effect; swaps the response on failure. */
  private async executeEffect(
    effect: NonNullable<ReturnType<typeof handleUssdTurn>['effect']>,
    phone: string,
    successResponse: string
  ): Promise<string> {
    try {
      if (effect.type === 'register') {
        await this.users.create({
          phone,
          fullName: effect.fullName,
          roles: [effect.role],
          preferredLanguage: 'en'
        });
        return successResponse;
      }
      const user = await this.users.findByPhone(phone);
      if (!user) {
        return 'END Register first (menu option 1) to enrol in a course.';
      }
      await this.learning.enrol(effect.courseId, user.id);
      return successResponse;
    } catch (error) {
      if (error instanceof ConflictException) {
        return effect.type === 'register'
          ? 'END This phone number is already registered.'
          : 'END You are already enrolled in this course.';
      }
      this.logger.warn(`USSD ${effect.type} effect failed: ${(error as Error).message}`);
      return 'END Service unavailable. Please try again shortly.';
    }
  }

  /** Gathers the menu data for one turn (latest price per crop, etc.). */
  private async menuData(): Promise<UssdMenuData> {
    const [priceRows, opportunities, courses] = await Promise.all([
      this.prices.find({}),
      this.opportunities.all(),
      this.learning.allCourses()
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
      opportunities: opportunities
        .filter((opportunity) => opportunity.isActive)
        .sort((a, b) => a.deadline.localeCompare(b.deadline))
        .slice(0, 3)
        .map((opportunity) => ({
          id: opportunity.id,
          title: opportunity.title,
          type: opportunity.type,
          deadline: opportunity.deadline
        })),
      courses: courses
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 25)
        .map((course) => ({ id: course.id, title: course.title }))
    };
  }
}
