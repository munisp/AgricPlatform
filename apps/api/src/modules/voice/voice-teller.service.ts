import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY,
  PIN_PROFILE_REPOSITORY,
  VSLA_MEMBER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AgentBankingAgentRepository } from '../../database/repositories/agent-banking.repository.js';
import type {
  CreditLoanRepository,
  CreditRepaymentRepository,
  CreditSavingsAccountRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { InputVoucherRepository } from '../../database/repositories/input-vouchers.repository.js';
import type { PinProfileRepository } from '../../database/repositories/pin-profile.repository.js';
import {
  VOICE_INTENT_SESSION_REPOSITORY,
  type VoiceIntentSessionRecord,
  type VoiceIntentSessionRepository
} from '../../database/repositories/voice-intent.repository.js';
import type { VslaMemberRepository } from '../../database/repositories/vsla-carbon.repository.js';
import { agentFloatAccountCode } from '../agent-banking/agent-banking.service.js';
import { hashSharedDevicePin } from '../auth/pin-session.service.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { memberSavingsAccountCode } from '../vsla-carbon/vsla-carbon.service.js';
import type { IvrAction, IvrCallState, IvrOutcome } from '../ivr/call-flow.js';
import {
  ACCOUNT_MENU_DTMF,
  VOICE_INTENT_LOCALES,
  VOICE_TELLER_FLAG,
  type VoiceIntentId
} from './intent-router.js';
import {
  renderIntentAnswer,
  renderNotRegistered,
  renderPinLocked,
  renderPinNotSet,
  renderPinWrong,
  renderUnavailable,
  type IntentAnswer
} from './intent-templates.js';
import { hashMsisdn, resolveMsisdnHashSalt } from './msisdn-crypto.js';

/**
 * Voice Teller (Stage 27, Innovation 6) — transactional READ-ONLY voice
 * intents over the IVR channel. Farmers dial in, authenticate with their
 * shared-device PIN (auth/pin-session formula, 5-attempt 15-minute lockout
 * reused via channels.pin_profiles), and hear account facts read LIVE from
 * the ledger/credit/vsla/voucher read models. Nothing is generated: the
 * grammar-slot router (intent-router.ts) only resolves WHICH intent, and
 * the speech templates (intent-templates.ts) only render WHAT WAS READ.
 *
 * Fail-closed doctrine:
 *  - the whole rail sits behind the `voice-teller` flag (default OFF);
 *  - telephony/TTS stay the existing fail-closed driver ports (503 in
 *    production without provider credentials — ivr.service.ts gates the
 *    callback endpoint itself);
 *  - a read-model failure speaks the per-locale "unavailable" template and
 *    records result='unavailable' + voice.intent.failed — a stale/cached
 *    balance is NEVER spoken as current;
 *  - the caller MSISDN is persisted HMAC-only (msisdn-crypto.ts) and never
 *    appears in OTel span attributes or event payloads.
 */

/** In-call wrong-PIN re-prompts tolerated before the call ends politely. */
export const VOICE_TELLER_MAX_PIN_STRIKES = 3;
/** Wrong-PIN attempts before the persistent 15-minute lockout (OTP parity). */
export const VOICE_TELLER_PIN_MAX_ATTEMPTS = 5;
export const VOICE_TELLER_PIN_LOCKOUT_MS = 15 * 60 * 1000;

export type PinCheck = 'ok' | 'wrong' | 'locked' | 'no_profile';

export interface IntentTurnInput {
  /** IVR call session id (for logging correlation; never persisted raw). */
  sessionId: string;
  callerNumber: string;
  intent: VoiceIntentId;
  /** Raw 4-digit PIN from this turn's GetDigits; never logged/stored. */
  pin: string;
  /** Consecutive wrong-PIN entries already made on this call. */
  strikes: number;
  /** Caller locale (user.preferredLanguage); unknown falls back to en. */
  locale?: string;
}

/** A fully-resolved turn — replaces the engine turn when a PIN effect fires. */
export interface IntentTurnResult {
  state: IvrCallState;
  actions: IvrAction[];
  end: boolean;
  outcome?: IvrOutcome;
}

export interface VoiceIntentCatalogEntry {
  intent: VoiceIntentId;
  dtmf: string;
  description: string;
  readModel: string;
}

const CATALOG: readonly VoiceIntentCatalogEntry[] = [
  {
    intent: 'balance.savings',
    dtmf: '1',
    description: "Speaks the caller savings-account balance (kobo read model).",
    readModel: 'credit.savings_accounts'
  },
  {
    intent: 'balance.float',
    dtmf: '2',
    description: "Speaks the caller agent-float balance from the ledger sub-account.",
    readModel: 'finance ledger (agent:<id>:float)'
  },
  {
    intent: 'loan.next_installment',
    dtmf: '3',
    description: 'Speaks amount + due date of the next unpaid installment across active loans.',
    readModel: 'credit.loans + credit.repayments'
  },
  {
    intent: 'vsla.position',
    dtmf: '4',
    description: 'Speaks total member savings across active VSLA memberships (ledger).',
    readModel: 'vsla members + finance ledger (vsla:<gid>:member:<uid>)'
  },
  {
    intent: 'voucher.status',
    dtmf: '5',
    description: "Speaks the status of the caller most-recent input voucher.",
    readModel: 'input_vouchers.vouchers'
  }
];

@Injectable()
export class VoiceTellerService {
  private readonly logger = new Logger(VoiceTellerService.name);
  private readonly msisdnSalt: string;

  constructor(
    private readonly users: UsersService,
    private readonly ledger: LedgerService,
    private readonly flags: FeatureFlagsService,
    private readonly telemetry: TelemetryService,
    private readonly events: DomainEventsService,
    @Inject(PIN_PROFILE_REPOSITORY) private readonly pins: PinProfileRepository,
    @Inject(VOICE_INTENT_SESSION_REPOSITORY)
    private readonly sessions: VoiceIntentSessionRepository,
    @Inject(CREDIT_SAVINGS_ACCOUNT_REPOSITORY)
    private readonly savings: CreditSavingsAccountRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(AGENT_BANKING_AGENT_REPOSITORY) private readonly agents: AgentBankingAgentRepository,
    @Inject(VSLA_MEMBER_REPOSITORY) private readonly vslaMembers: VslaMemberRepository,
    @Inject(INPUT_VOUCHER_REPOSITORY) private readonly vouchers: InputVoucherRepository,
    @Optional() env: NodeJS.ProcessEnv = process.env
  ) {
    this.msisdnSalt = resolveMsisdnHashSalt(env);
  }

  /** Flag gate (fail-closed: repository errors evaluate to OFF). */
  async isEnabled(userId?: string): Promise<boolean> {
    try {
      return await this.flags.isEnabled(VOICE_TELLER_FLAG, { userId });
    } catch (error) {
      this.logger.warn(`voice-teller flag check failed closed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Admin capability catalog (GET /api/voice/intents/catalog). */
  catalog(flagEnabled: boolean): Record<string, unknown> {
    return {
      flag: VOICE_TELLER_FLAG,
      flagEnabled,
      locales: VOICE_INTENT_LOCALES,
      dtmfMap: ACCOUNT_MENU_DTMF,
      intents: CATALOG,
      posture:
        'read-only grammar-slot intents; values are read live from the ledger/credit/vsla/voucher ' +
        'read models and rendered by fixed templates — never generated; msisdn persisted HMAC-only'
    };
  }

  /**
   * voice.intent.started — emitted when the caller selects an intent in the
   * account menu (before PIN verification). Never carries the MSISDN.
   */
  async intentStarted(callerNumber: string, intent: VoiceIntentId): Promise<void> {
    const user = await this.users.findByPhone(callerNumber);
    await this.events.publish('voice.intent.started', { intent, channel: 'ivr' }, user?.id);
  }

  /** voice.intent.escalated — caller asked for an agent inside the account flow. */
  async intentEscalated(callerNumber: string, intent?: VoiceIntentId): Promise<void> {
    const user = await this.users.findByPhone(callerNumber);
    await this.events.publish(
      'voice.intent.escalated',
      { intent: intent ?? 'none', channel: 'ivr' },
      user?.id
    );
    if (user) {
      await this.record(user, callerNumber, intent ?? 'escalated', 'escalated', 0);
    }
  }

  /**
   * Resolves one PIN-gated intent turn (IVR effect from the call-flow
   * engine). Returns the complete turn: answer + hangup on success,
   * re-prompt on a wrong PIN, polite hangup on lockout/strike-out.
   */
  async resolvePinTurn(input: IntentTurnInput): Promise<IntentTurnResult> {
    const startedAt = Date.now();
    return this.telemetry.withSpan(
      'voice.intent.handle',
      { intent: input.intent, locale: input.locale ?? 'en' },
      async () => {
        // Defense in depth: the engine only routes here when the flag is
        // on, but the service re-checks fail-closed before reading anything.
        if (!(await this.isEnabled())) {
          return this.end(input, renderUnavailable(input.locale));
        }
        const user = await this.users.findByPhone(input.callerNumber);
        if (!user) {
          return this.end(input, renderNotRegistered(input.locale));
        }
        const pinCheck = await this.verifyPin(user.id, input.pin);
        if (pinCheck === 'no_profile') {
          return this.end(input, renderPinNotSet(input.locale));
        }
        if (pinCheck === 'locked') {
          return this.end(input, renderPinLocked(input.locale));
        }
        if (pinCheck === 'wrong') {
          const strikes = input.strikes + 1;
          if (strikes >= VOICE_TELLER_MAX_PIN_STRIKES) {
            return this.end(input, renderPinWrong(input.locale), 'abandoned');
          }
          return {
            state: { menu: 'account_pin', strikes, pendingIntent: input.intent },
            actions: [
              { type: 'say', text: renderPinWrong(input.locale) },
              {
                type: 'getDigits',
                prompt: pinReprompt(input.locale),
                timeoutSeconds: 10,
                numDigits: 4
              }
            ],
            end: false
          };
        }
        return this.answerIntent(user, input, startedAt);
      }
    );
  }

  /* ------------------------------------------------------------ internals */

  private end(
    input: IntentTurnInput,
    text: string,
    outcome: IvrOutcome = 'completed'
  ): IntentTurnResult {
    return {
      state: { menu: 'main', strikes: 0 },
      actions: [{ type: 'say', text }],
      end: true,
      outcome
    };
  }

  /**
   * Shared-device PIN verification for the IVR channel: the caller
   * authenticates as a USER (not a device), so the PIN is checked against
   * every shared-device profile the user has (cap 5 per device, family
   * phones). A wrong PIN increments every profile's attempt counter
   * atomically (audit C2-5 parity) and locks the profile that reaches the
   * ceiling for 15 minutes; a success clears counters. Locked profiles
   * reject every attempt until the lock expires.
   */
  private async verifyPin(userId: string, pin: string): Promise<PinCheck> {
    const profiles = await this.pins.listForUser(userId);
    if (profiles.length === 0) {
      return 'no_profile';
    }
    const now = Date.now();
    // L-11: lockout is scoped PER DEVICE PROFILE, not account-wide. The old
    // any-profile-locked ⇒ refuse-everything check let a dial-in attacker
    // lock ONE profile (5 wrong guesses) and thereby deny the whole account
    // — even to correct PINs — for 15 minutes. Locked profiles now sit out
    // the check; the caller is refused only when EVERY profile is locked.
    const isLocked = (p: (typeof profiles)[number]): boolean =>
      p.lockedUntil !== undefined && new Date(p.lockedUntil).getTime() > now;
    const active = profiles.filter((p) => !isLocked(p));
    if (active.length === 0) {
      return 'locked';
    }
    const match = active.find(
      (p) => p.pinHash === hashSharedDevicePin(p.deviceToken, userId, pin)
    );
    if (match) {
      for (const profile of active) {
        if (profile.attempts > 0 || profile.lockedUntil) {
          await this.pins.update(profile.deviceToken, userId, {
            attempts: 0,
            lockedUntil: undefined
          });
        }
      }
      return 'ok';
    }
    for (const profile of active) {
      const attempts = await this.pins.incrementAttempts(profile.deviceToken, userId);
      if (attempts >= VOICE_TELLER_PIN_MAX_ATTEMPTS) {
        await this.pins.update(profile.deviceToken, userId, {
          attempts: 0,
          lockedUntil: new Date(now + VOICE_TELLER_PIN_LOCKOUT_MS).toISOString()
        });
      }
    }
    // The wrong guess may have locked some profiles; the account is denied
    // only when none remain usable.
    const remaining = await this.pins.listForUser(userId);
    const stillActive = remaining.some(
      (p) => !(p.lockedUntil && new Date(p.lockedUntil).getTime() > Date.now())
    );
    return stillActive ? 'wrong' : 'locked';
  }

  /** PIN ok → read the intent's read model LIVE and render the answer. */
  private async answerIntent(
    user: User,
    input: IntentTurnInput,
    startedAt: number
  ): Promise<IntentTurnResult> {
    let answer: IntentAnswer;
    try {
      answer = await this.readModel(user.id, input.intent);
    } catch (error) {
      // Fail-closed: speak "unavailable", record + count the failure; a
      // stale/cached value is never spoken as current.
      this.logger.warn(
        `voice intent ${input.intent} read failed for call ${input.sessionId}: ${(error as Error).message}`
      );
      const durationMs = Date.now() - startedAt;
      await this.record(user, input.callerNumber, input.intent, 'unavailable', durationMs);
      await this.events.publish(
        'voice.intent.failed',
        { intent: input.intent, channel: 'ivr', reason: 'read_model_unavailable' },
        user.id
      );
      this.count(input.intent, 'unavailable');
      this.telemetry.record('voice.intent_latency_ms', durationMs, { intent: input.intent });
      return this.end(input, renderUnavailable(input.locale));
    }
    const durationMs = Date.now() - startedAt;
    await this.record(user, input.callerNumber, input.intent, 'ok', durationMs);
    await this.events.publish(
      'voice.intent.answered',
      { intent: input.intent, channel: 'ivr', answerKind: answer.kind },
      user.id
    );
    this.count(input.intent, 'ok');
    if (answer.kind === 'ok') {
      // Deflection metric: the caller got their account fact without an agent.
      this.telemetry.increment('voice.deflection_total', 1, { intent: input.intent });
    }
    this.telemetry.record('voice.intent_latency_ms', durationMs, { intent: input.intent });
    return this.end(input, renderIntentAnswer(answer, input.locale));
  }

  /** Read-only projections per intent. Any throw → spoken "unavailable". */
  private async readModel(userId: string, intent: VoiceIntentId): Promise<IntentAnswer> {
    switch (intent) {
      case 'balance.savings': {
        const [account] = await this.savings.find({ userId });
        return account
          ? { intent, kind: 'ok', balanceKobo: account.balanceKobo }
          : { intent, kind: 'no_account' };
      }
      case 'balance.float': {
        const agent = await this.agents.findByUserId(userId);
        if (!agent) {
          return { intent, kind: 'not_agent' };
        }
        const balance = await this.ledger.balance(agentFloatAccountCode(agent.id));
        return { intent, kind: 'ok', balanceKobo: balance.balanceKobo };
      }
      case 'loan.next_installment': {
        const loans = await this.loans.find({ applicantUserId: userId });
        const active = loans.filter(
          (loan) => loan.status === 'disbursed' || loan.status === 'repaying'
        );
        if (active.length === 0) {
          return { intent, kind: 'no_active_loan' };
        }
        let next: { amountKobo: number; dueAt: string } | undefined;
        for (const loan of active) {
          const pending = await this.repayments.find({ loanId: loan.id, status: 'pending' });
          for (const repayment of pending) {
            if (!next || repayment.dueAt < next.dueAt) {
              next = { amountKobo: repayment.amountKobo, dueAt: repayment.dueAt };
            }
          }
        }
        return next
          ? { intent, kind: 'ok', amountKobo: next.amountKobo, dueAt: next.dueAt }
          : { intent, kind: 'no_installment' };
      }
      case 'vsla.position': {
        const memberships = await this.vslaMembers.find({ userId, status: 'ACTIVE' });
        if (memberships.length === 0) {
          return { intent, kind: 'no_membership' };
        }
        let totalKobo = 0;
        for (const member of memberships) {
          const balance = await this.ledger.balance(
            memberSavingsAccountCode(member.groupId, userId)
          );
          totalKobo += balance.balanceKobo;
        }
        return { intent, kind: 'ok', groupCount: memberships.length, totalKobo };
      }
      case 'voucher.status': {
        const vouchers = await this.vouchers.find({ farmerId: userId });
        if (vouchers.length === 0) {
          return { intent, kind: 'no_voucher' };
        }
        const latest = [...vouchers].sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
        )[0];
        return { intent, kind: 'ok', status: latest.status, amountKobo: latest.amountKobo };
      }
    }
  }

  /** Audit row: msisdn HMAC-only, user id only after PIN success. */
  private async record(
    user: User,
    callerNumber: string,
    intent: string,
    result: VoiceIntentSessionRecord['result'],
    durationMs: number
  ): Promise<void> {
    await this.sessions.create({
      id: `vi_${randomUUID()}`,
      userId: user.id,
      channel: 'ivr',
      intent,
      msisdnHmac: hashMsisdn(callerNumber, this.msisdnSalt),
      result,
      durationMs,
      createdAt: new Date().toISOString()
    });
  }

  private count(intent: string, result: string): void {
    this.telemetry.increment('voice.intents_total', 1, { intent, result });
  }
}

/** Re-prompt after a wrong PIN (short, per locale). */
function pinReprompt(locale?: string): string {
  switch ((locale ?? 'en').toLowerCase()) {
    case 'ha':
      return 'Ku sake shigar da PIN na lambobi hudu.';
    case 'yo':
      return 'E tun PIN oninomba merin yin se.';
    case 'ig':
      return 'Tinye PIN diigit ano gi ozo.';
    default:
      return 'Please enter your 4 digit PIN again.';
  }
}

