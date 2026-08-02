import type { KycTier } from '@agric-platform/shared';

/**
 * IVR call-flow engine (wave P6a) — a pure, deterministic state machine for
 * Africa's Talking Voice sessions. The engine never performs I/O: the caller
 * passes the current state, the DTMF digits for this turn and the data the
 * menu needs, and receives the next state, the Voice XML actions to render
 * and an optional side effect (agent callback request) for the service layer.
 *
 * Outbound TTS note: every spoken string lives in the PROMPTS map below as
 * plain English text. Professional voice recording / TTS voice selection is a
 * provider-side external concern (Africa's Talking `voice` attribute or
 * pre-recorded `<Play>` URLs) and intentionally out of scope here.
 */

/** Africa's Talking GetDigits timeout (seconds) for every menu prompt. */
export const IVR_GET_DIGITS_TIMEOUT_SECONDS = 5;
/** Invalid/timeout re-prompts tolerated before the call ends politely. */
export const IVR_MAX_STRIKES = 3;

export type IvrMenuId = 'main' | 'price_select';

export interface IvrCallState {
  menu: IvrMenuId;
  /** Consecutive invalid/timeout entries on the current menu. */
  strikes: number;
}

/** Data the current turn may need; gathered by the service per callback. */
export interface IvrMenuData {
  /** Latest observation per crop (≤6 offered). */
  prices: Array<{
    crop: string;
    market: string;
    state: string;
    priceNgn: number;
    observedAt: string;
  }>;
  /** Latest advisory for the caller's state (or national fallback). */
  advisory?: { title: string; summary: string; kind: string };
  /** Caller's registration snapshot when the phone number is known. */
  caller?: {
    fullName: string;
    kycTier: KycTier;
    /** 0–100 profile completion score from the profiles module. */
    profileCompleteness: number;
    enrolments: { total: number; inProgress: number; completed: number };
  };
}

export type IvrEffect = { type: 'callback_request' };

export type IvrOutcome = 'completed' | 'abandoned' | 'escalated';

/**
 * Africa's Talking Voice actions. `reject` is rendered as `<Reject/>` and is
 * used defensively when digits arrive for an already-terminated call.
 */
export type IvrAction =
  | { type: 'say'; text: string }
  | { type: 'getDigits'; prompt: string; timeoutSeconds: number; numDigits: number }
  | { type: 'enqueue' }
  | { type: 'reject' };

export interface IvrTurn {
  state: IvrCallState;
  actions: IvrAction[];
  /** True when the call ends after these actions (no input expected). */
  end: boolean;
  /** Terminal outcome to persist on the call record; unset while active. */
  outcome?: IvrOutcome;
  effect?: IvrEffect;
}

/**
 * Spoken prompt strings. Plain-English text only — voice talent recording or
 * TTS voice/gender selection is configured on the telephony provider side
 * (Africa's Talking dashboard / `voice` attribute), not in this codebase.
 */
export const PROMPTS = {
  welcome: 'Welcome to AgricPlatform voice service.',
  main_menu:
    'Press 1 for commodity prices. Press 2 for crop advisory. ' +
    'Press 3 for your registration status. Press 4 for your course enrolment status. ' +
    'Press 9 to repeat this menu. Press 0 to speak to an agent.',
  invalid_choice: 'Sorry, that was not a valid choice.',
  no_input: 'We did not hear any input.',
  too_many_attempts: 'Too many invalid entries. Thank you for calling AgricPlatform. Goodbye.',
  goodbye: 'Thank you for calling AgricPlatform. Goodbye.',
  no_prices: 'There are no market prices available right now. Please try again later.',
  price_prompt: 'Select a crop.',
  invalid_crop: 'Sorry, that crop number is not on the list.',
  no_advisory: 'There is no crop advisory available right now. Please try again later.',
  not_registered:
    'This phone number is not registered on AgricPlatform. ' +
    'Please register using our U S S D menu or mobile app, then call again.',
  no_courses: 'You are not enrolled in any courses yet.',
  escalation:
    'Please hold while we connect you to an AgricPlatform agent. ' +
    'If no agent is available, we will call you back on this number.'
} as const;

export function initialIvrState(): IvrCallState {
  return { menu: 'main', strikes: 0 };
}

function say(text: string): IvrAction {
  return { type: 'say', text };
}

function ask(prompt: string): IvrAction {
  return {
    type: 'getDigits',
    prompt,
    timeoutSeconds: IVR_GET_DIGITS_TIMEOUT_SECONDS,
    numDigits: 1
  };
}

function endTurn(state: IvrCallState, text: string, outcome: IvrOutcome): IvrTurn {
  return { state, actions: [say(text)], end: true, outcome };
}

function formatPriceNgn(value: number): string {
  return `${Math.round(value).toLocaleString('en-NG')} naira`;
}

/** Voice-friendly KYC tier label ('tier_2' → 'tier 2'). */
export function formatKycTier(tier: KycTier): string {
  return tier.replace('_', ' ');
}

function cropMenuPrompt(prices: IvrMenuData['prices']): string {
  const options = prices
    .slice(0, 6)
    .map((price, index) => `Press ${index + 1} for ${price.crop}.`)
    .join(' ');
  return `${PROMPTS.price_prompt} ${options}`;
}

function priceSummary(price: IvrMenuData['prices'][number]): string {
  const day = price.observedAt.slice(0, 10);
  return (
    `${price.crop} is ${formatPriceNgn(price.priceNgn)} at ${price.market} market, ` +
    `${price.state}. Recorded on ${day}. ${PROMPTS.goodbye}`
  );
}

function advisorySummary(advisory: NonNullable<IvrMenuData['advisory']>): string {
  return `Latest crop advisory: ${advisory.title}. ${advisory.summary} ${PROMPTS.goodbye}`;
}

function registrationSummary(caller: NonNullable<IvrMenuData['caller']>): string {
  return (
    `${caller.fullName}, you are registered on AgricPlatform with K Y C ` +
    `${formatKycTier(caller.kycTier)}. Your profile is ${caller.profileCompleteness} percent ` +
    `complete. ${PROMPTS.goodbye}`
  );
}

function enrolmentSummary(caller: NonNullable<IvrMenuData['caller']>): string {
  if (caller.enrolments.total === 0) {
    return `${PROMPTS.no_courses} ${PROMPTS.goodbye}`;
  }
  const { total, inProgress, completed } = caller.enrolments;
  return (
    `You are enrolled in ${total} ${total === 1 ? 'course' : 'courses'}: ` +
    `${inProgress} in progress and ${completed} completed. ${PROMPTS.goodbye}`
  );
}

/**
 * Advances the machine one turn. `digits` is the Africa's Talking
 * `dtmfDigits` field for this callback: `undefined` on the opening ring (no
 * prior session) and the empty string when the caller let the GetDigits
 * timeout lapse. A timeout counts as an invalid entry (strike).
 */
export function handleIvrTurn(
  state: IvrCallState,
  digits: string | undefined,
  data: IvrMenuData
): IvrTurn {
  if (digits === undefined) {
    // Opening ring: greet and present the main menu.
    return {
      state: initialIvrState(),
      actions: [say(PROMPTS.welcome), ask(PROMPTS.main_menu)],
      end: false
    };
  }
  const input = digits.trim();
  if (input === '') {
    return reprompt(state, PROMPTS.no_input);
  }

  switch (state.menu) {
    case 'main':
      return handleMain(state, input, data);
    case 'price_select':
      return handlePriceSelect(state, input, data);
  }
}

/** Invalid-entry path shared by every menu: strike, re-prompt or END at 3. */
function reprompt(state: IvrCallState, reason: string): IvrTurn {
  const strikes = state.strikes + 1;
  if (strikes >= IVR_MAX_STRIKES) {
    return endTurn({ ...state, strikes }, PROMPTS.too_many_attempts, 'abandoned');
  }
  const prompt = state.menu === 'price_select' ? PROMPTS.price_prompt : PROMPTS.main_menu;
  return {
    state: { ...state, strikes },
    actions: [say(reason), ask(prompt)],
    end: false
  };
}

function handleMain(state: IvrCallState, input: string, data: IvrMenuData): IvrTurn {
  switch (input) {
    case '1': {
      const crops = data.prices.slice(0, 6);
      if (crops.length === 0) {
        return endTurn(state, `${PROMPTS.no_prices} ${PROMPTS.goodbye}`, 'completed');
      }
      return {
        state: { menu: 'price_select', strikes: 0 },
        actions: [ask(cropMenuPrompt(crops))],
        end: false
      };
    }
    case '2': {
      if (!data.advisory) {
        return endTurn(state, `${PROMPTS.no_advisory} ${PROMPTS.goodbye}`, 'completed');
      }
      return endTurn(state, advisorySummary(data.advisory), 'completed');
    }
    case '3': {
      if (!data.caller) {
        return endTurn(state, PROMPTS.not_registered, 'completed');
      }
      return endTurn(state, registrationSummary(data.caller), 'completed');
    }
    case '4': {
      if (!data.caller) {
        return endTurn(state, PROMPTS.not_registered, 'completed');
      }
      return endTurn(state, enrolmentSummary(data.caller), 'completed');
    }
    case '9':
      // Repeat the menu without touching the strike counter.
      return { state, actions: [ask(PROMPTS.main_menu)], end: false };
    case '0':
      return {
        state,
        actions: [say(PROMPTS.escalation), { type: 'enqueue' }],
        end: true,
        outcome: 'escalated',
        effect: { type: 'callback_request' }
      };
    default:
      return reprompt(state, PROMPTS.invalid_choice);
  }
}

function handlePriceSelect(state: IvrCallState, input: string, data: IvrMenuData): IvrTurn {
  const crops = data.prices.slice(0, 6);
  const index = Number.parseInt(input, 10);
  const price = crops[index - 1];
  if (!price) {
    return reprompt(state, PROMPTS.invalid_crop);
  }
  return endTurn(initialIvrState(), priceSummary(price), 'completed');
}
