import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { missingAtCallbackConfig } from '../../common/auth/at-callback.utils.js';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  COMMODITY_PRICE_REPOSITORY,
  KEY_VALUE_STORE,
  USSD_SESSION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { KeyValueStore } from '../../redis/key-value-store.js';
import type { CommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import type {
  UssdSessionRecord,
  UssdSessionRepository
} from '../../database/repositories/ussd-session.repository.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  PLANTING_PULSE_FLAG,
  PlantingPulseService
} from '../advisory/planting-pulse.service.js';
import { PRICE_WIRE_FLAG, PriceWireService } from '../advisory/price-wire.service.js';
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
/**
 * Per-phone registration-effect rate limit (V-19, production profile): a
 * callback-token holder probing MSISDNs through the register menu cannot
 * cycle unbounded registration effects for one number.
 */
export const USSD_REGISTER_MAX_PER_WINDOW = 5;
export const USSD_REGISTER_WINDOW_MS = 60 * 60 * 1000;

const USSD_PROVIDER = 'africastalking-ussd';

/**
 * Perf P1-2: TTL for the phone-independent menu reference bundle (latest
 * prices, active opportunities, course list) cached in the shared
 * KeyValueStore. Menus are top-N slices of slowly changing reference data,
 * so a 60 s staleness window is invisible to callers while collapsing
 * 3 full-table scans per turn into one read per window.
 */
export const USSD_MENU_CACHE_TTL_MS = 60_000;
const USSD_MENU_CACHE_KEY = 'ussd:menu-reference:v1';

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
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env,
    // Stage 27 (innovation 4): Planting-Window Pulse pull path. Optional so
    // bare service constructions in pre-existing unit tests keep working;
    // when unwired the menu answers "unavailable" honestly.
    @Optional() private readonly pulse?: PlantingPulseService,
    // Stage 27 (innovation 11): Price Wire pull path. Optional so bare
    // service constructions in pre-existing unit tests keep working; when
    // unwired the menu answers "unavailable" honestly.
    @Optional() private readonly priceWire?: PriceWireService,
    @Optional() private readonly flags?: FeatureFlagsService,
    // OB-09: shared counter store for the registration rate limit — Redis in
    // production (RedisModule is @Global, so this is always wired in the
    // app), in-memory only in bare unit-test constructions.
    @Optional() @Inject(KEY_VALUE_STORE) private readonly kv?: KeyValueStore
  ) {
    this.driverConfig = resolveUssdDriver(env);
    // Fail closed at boot in production: a live/sandbox USSD driver without
    // the Africa's Talking credentials OR the callback shared secret
    // (AT_CALLBACK_TOKEN, audit C2-3) aborts startup (wave P1 pattern).
    if (isProduction() && this.driverConfig.mode !== 'stub') {
      const missing = [...this.driverConfig.missing, ...missingAtCallbackConfig(env)];
      if (missing.length > 0) {
        throw new ProviderConfigError(USSD_PROVIDER, missing);
      }
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

    // Session phone binding (audit C2-3): a live session stays bound to the
    // phone number that opened it; mid-session phone changes are rejected
    // instead of silently re-attributing the session.
    if (
      existing &&
      existing.expiresAt > new Date(now).toISOString() &&
      existing.phone !== input.phoneNumber
    ) {
      throw new UnauthorizedException(
        'USSD session is bound to a different phone number; start a new session.'
      );
    }

    const liveExisting =
      existing && existing.expiresAt > new Date(now).toISOString() ? existing : undefined;
    if (liveExisting) {
      const storedState = liveExisting.state as unknown as StoredUssdState;
      if (storedState.lastText === text && storedState.lastResponse !== undefined) {
        return storedState.lastResponse;
      }
      // Cumulative-text ordering (V-66): AT sends the full `*`-joined input
      // history on every turn, so the new text must extend the last
      // processed text by exactly one segment. Out-of-order delivery or a
      // rewritten history is rejected with a re-sync END instead of silently
      // feeding the last segment to the wrong menu state.
      const lastText = storedState.lastText ?? '';
      const lastSegments = lastText === '' ? 0 : lastText.split('*').length;
      const newSegments = text === '' ? 0 : text.split('*').length;
      const extendsByOne =
        newSegments === lastSegments + 1 && (lastText === '' || text.startsWith(`${lastText}*`));
      if (!extendsByOne) {
        return 'END Session out of sync. Please hang up and dial again.';
      }
    } else if (text !== '') {
      // Expired/unknown session carrying accumulated input (V-66): never
      // restart the flow from the last segment — expire explicitly.
      return 'END Session expired. Please dial again.';
    }

    const stored = liveExisting ? (liveExisting.state as unknown as StoredUssdState) : undefined;
    const engineState = stored?.engine ?? initialUssdState();
    const segment = text.split('*').pop() ?? '';

    const data = await this.menuData(input.phoneNumber);
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
        if (await this.registrationRateLimited(phone)) {
          return 'END Too many registration attempts for this number. Please try again later.';
        }
        const created = await this.users.create({
          phone,
          fullName: effect.fullName,
          roles: [effect.role],
          preferredLanguage: 'en'
        });
        // OB-01c: USSD registration arrives over the telco channel — the
        // Africa's Talking callback only fires for the MSISDN holding the
        // line, so line possession IS the verification proof. Mark the
        // account verified at creation (web/API registration stays
        // unverified until OTP proof instead).
        await this.users.setVerified(created.id, true);
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

  /**
   * Per-phone registration-effect rate limit (V-19, OB-09), production
   * profile only — non-production behavior is unchanged. Returns true when
   * the phone has exhausted its registration window.
   *
   * The counter lives in the shared KeyValueStore (Redis in production), so
   * the cap holds across API replicas; the window is anchored at the first
   * attempt (TTL applied only when the counter is created). DEGRADED MODE
   * follows the platform's store-of-record pattern (V-77, cf.
   * redis/otp-challenge.store.ts): this limiter is an anti-probing security
   * control, not a cache, so a backing-store outage FAILS CLOSED — the
   * registration effect is refused with a retryable "service unavailable"
   * response rather than letting unbounded registrations slip through.
   */
  private async registrationRateLimited(phone: string): Promise<boolean> {
    if (!isProduction()) {
      return false;
    }
    if (!this.kv) {
      // Unreachable in the app (RedisModule is @Global); bare constructions
      // in production fail closed rather than silently skipping the cap.
      this.logger.error('USSD registration rate limit has no counter store — failing closed');
      throw new ServiceUnavailableException(
        'USSD registration rate limit unavailable (no counter store)'
      );
    }
    try {
      const attempts = await this.kv.incr(
        `ussd:register:${phone}`,
        USSD_REGISTER_WINDOW_MS
      );
      return attempts > USSD_REGISTER_MAX_PER_WINDOW;
    } catch (error) {
      this.logger.error(
        `USSD registration rate-limit counter failed (${error instanceof Error ? error.message : String(error)}) — failing closed`
      );
      throw new ServiceUnavailableException(
        'USSD registration rate limit temporarily unavailable'
      );
    }
  }

  /** Gathers the menu data for one turn (latest price per crop, etc.). */
  private async menuData(phone: string): Promise<UssdMenuData> {
    const [reference, plantingPulse, priceWire] = await Promise.all([
      this.menuReferenceData(),
      this.plantingPulseFor(phone),
      this.priceWireFor(phone)
    ]);
    return {
      ...reference,
      ...(plantingPulse ? { plantingPulse } : {}),
      ...(priceWire ? { priceWire } : {})
    };
  }

  /**
   * Phone-independent menu bundle (perf P1-2). Served from the shared
   * KeyValueStore with a 60 s TTL; this is a CACHE, not a store of record,
   * so it FAILS OPEN — a miss, parse error or store outage reads through to
   * the repositories. (Contrast the registration rate limiter above, an
   * anti-probing control that stays fail-closed.) The cache write happens
   * off the hot path and never breaks a turn.
   */
  private async menuReferenceData(): Promise<
    Pick<UssdMenuData, 'prices' | 'opportunities' | 'courses'>
  > {
    const cached = await this.readMenuCache();
    if (cached) {
      return cached;
    }
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
    const bundle: Pick<UssdMenuData, 'prices' | 'opportunities' | 'courses'> = {
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
    if (this.kv) {
      // try/catch (not just .catch): a minimal store double that lacks set()
      // throws synchronously, and that must not break the turn either.
      try {
        void this.kv
          .set(USSD_MENU_CACHE_KEY, JSON.stringify(bundle), USSD_MENU_CACHE_TTL_MS)
          .catch((error: unknown) =>
            this.logger.warn(
              `USSD menu cache write failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
      } catch (error) {
        this.logger.warn(
          `USSD menu cache write failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return bundle;
  }

  /** Cache read for the menu bundle; any failure degrades to a miss. */
  private async readMenuCache(): Promise<
    Pick<UssdMenuData, 'prices' | 'opportunities' | 'courses'> | undefined
  > {
    if (!this.kv) {
      return undefined;
    }
    try {
      const raw = await this.kv.get(USSD_MENU_CACHE_KEY);
      return raw
        ? (JSON.parse(raw) as Pick<UssdMenuData, 'prices' | 'opportunities' | 'courses'>)
        : undefined;
    } catch (error) {
      this.logger.warn(
        `USSD menu cache read failed (reading through): ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  /**
   * Planting-Window Pulse pull data (Stage 27, innovation 4). Fail-closed
   * throughout: flag off/unwired → undefined (menu shows the honest
   * unavailable message); weather stub/outage/stale → the advisory service
   * itself returns available:false. Never fabricates a window.
   */
  private async plantingPulseFor(phone: string): Promise<UssdMenuData['plantingPulse']> {
    if (!this.pulse || !this.flags) {
      return undefined;
    }
    try {
      const user = await this.users.findByPhone(phone);
      if (!user) {
        return { available: false, reason: 'no_active_subscription' };
      }
      const enabled = await this.flags.isEnabled(PLANTING_PULSE_FLAG, {
        userId: user.id,
        roles: user.roles
      });
      if (!enabled) {
        return undefined;
      }
      const preview = await this.pulse.previewForUser(user.id);
      return {
        available: preview.available,
        ...(preview.reason ? { reason: preview.reason } : {}),
        ...(preview.message ? { text: preview.message } : {})
      };
    } catch (error) {
      this.logger.warn(`USSD planting-pulse lookup failed: ${(error as Error).message}`);
      return { available: false };
    }
  }

  /**
   * Price Wire pull data (Stage 27, innovation 11). Fail-closed throughout:
   * flag off/unwired or an unknown phone → undefined (the menu shows the
   * honest unavailable message); stale/stub feeds make the advisory service
   * itself mark quotes unavailable. Never fabricates a price.
   */
  private async priceWireFor(phone: string): Promise<UssdMenuData['priceWire']> {
    if (!this.priceWire || !this.flags) {
      return undefined;
    }
    try {
      const user = await this.users.findByPhone(phone);
      if (!user) {
        return undefined;
      }
      const enabled = await this.flags.isEnabled(PRICE_WIRE_FLAG, {
        userId: user.id,
        roles: user.roles
      });
      if (!enabled) {
        return undefined;
      }
      return await this.priceWire.wireMenuData();
    } catch (error) {
      this.logger.warn(`USSD price-wire lookup failed: ${(error as Error).message}`);
      return undefined;
    }
  }
}
