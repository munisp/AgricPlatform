import type { LanguageCode } from '@agric-platform/shared';

/**
 * USSD menu engine (wave P5b) — a pure, deterministic state machine for
 * Africa's Talking sessions. Every response is prefixed CON (session
 * continues) or END (session closes) and capped at 182 characters so it fits
 * one feature-phone screen. The engine never performs I/O: the caller passes
 * the current state, the latest input segment and the data the menu needs,
 * and receives the next state, the full response text and an optional side
 * effect (registration/enrolment) for the service layer to execute.
 *
 * This file intentionally contains no literal backslash sequences (MCP
 * channel hazard — see PR #71 notes); multi-line menu text uses template
 * literals with real newlines, which are byte-identical in value to escape
 * sequences.
 */

/** Africa's Talking turnaround limit for one USSD screen. */
export const USSD_MAX_RESPONSE_CHARS = 182;

/**
 * A single newline, expressed as a real line break inside a template
 * literal. This file intentionally contains no literal backslash sequences
 * (MCP channel hazard — see PR #71 notes); multi-line menu text uses real
 * newlines, which are byte-identical in value to escape sequences.
 */
const NEWLINE = `
`;

/** Roles offered during USSD self-registration (KYC tier 0 phone identity). */
export const USSD_REGISTRATION_ROLES = ['farmer', 'student', 'buyer', 'supplier'] as const;
export type UssdRegistrationRole = (typeof USSD_REGISTRATION_ROLES)[number];

export type UssdMenuId =
  | 'main'
  | 'register_name'
  | 'register_state'
  | 'register_role'
  | 'price_select'
  | 'wire_commodity'
  | 'wire_market'
  | 'course_code'
  | 'course_confirm'
  | 'language';

export interface UssdRegistrationDraft {
  fullName?: string;
  state?: string;
}

export interface UssdSessionState {
  menu: UssdMenuId;
  language: LanguageCode;
  draft: UssdRegistrationDraft;
  /** Course selected at course_code, awaiting confirmation. */
  courseId?: string;
  /** Commodity selected at wire_commodity, awaiting the market pick. */
  wireCommodity?: string;
}

/** Data the current turn may need; gathered by the service per callback. */
export interface UssdMenuData {
  /** Latest observation per crop (≤6 shown). */
  prices: Array<{
    crop: string;
    market: string;
    state: string;
    priceNgn: number;
    observedAt: string;
  }>;
  /** First open opportunities (≤3 shown). */
  opportunities: Array<{ id: string; title: string; type: string; deadline: string }>;
  /** Courses eligible for code-based enrolment. */
  courses: Array<{ id: string; title: string }>;
  /**
   * Planting-Window Pulse pull path (Stage 27, innovation 4): the caller's
   * next advisory, pre-rendered by the advisory module. Absent/available:false
   * → the menu answers honestly (never a fabricated window).
   */
  plantingPulse?: {
    available: boolean;
    /** 'no_active_subscription' shows the subscribe hint instead. */
    reason?: string;
    text?: string;
  };
  /**
   * Price Wire pull path (Stage 27, innovation 11): commodities, markets
   * and pre-rendered quotes computed by the advisory module. Absent or an
   * unavailable quote → the menu answers honestly (never a fabricated
   * price).
   */
  priceWire?: {
    commodities: string[];
    /** commodity → markets (most recently observed first). */
    markets: Record<string, string[]>;
    /** `${commodity}¦${market}` → rendered quote screen, when fresh+live. */
    quotes: Record<string, { available: boolean; text?: string }>;
  };
}

export type UssdEffect =
  | { type: 'register'; fullName: string; state: string; role: UssdRegistrationRole }
  | { type: 'enrol'; courseId: string; courseTitle: string };

export interface UssdTurn {
  state: UssdSessionState;
  /** Full response body including the CON/END prefix (≤182 chars). */
  response: string;
  end: boolean;
  effect?: UssdEffect;
}

/**
 * Localisation scaffold (wave P5b ships English only). Keys are the full set
 * the menus need; Hausa/Yoruba/Igbo slots exist so translations drop in
 * without engine changes — `t` falls back to English until then.
 */
const SUPPORTED_LANGUAGES: readonly LanguageCode[] = ['en'];

type StringKey =
  | 'main_menu'
  | 'invalid_choice'
  | 'ask_name'
  | 'invalid_name'
  | 'ask_state'
  | 'invalid_state'
  | 'ask_role'
  | 'invalid_role'
  | 'registration_done'
  | 'no_prices'
  | 'price_prompt'
  | 'invalid_crop'
  | 'no_opportunities'
  | 'opportunities_header'
  | 'ask_course_code'
  | 'no_courses'
  | 'course_not_found'
  | 'course_confirm'
  | 'enrolment_done'
  | 'enrolment_cancelled'
  | 'invalid_confirmation'
  | 'language_menu'
  | 'language_set'
  | 'pulse_unavailable'
  | 'pulse_none'
  | 'wire_prompt'
  | 'wire_market_prompt'
  | 'wire_unavailable';

const STRINGS: Record<'en', Record<StringKey, string>> = {
  en: {
    main_menu: `Welcome to AgricPlatform
1 Register
2 Market prices
3 Opportunities
4 Course enrolment
5 Planting window
6 Price check
0 Language`,
    invalid_choice: 'Invalid choice.',
    ask_name: 'Enter your full name:',
    invalid_name: 'Invalid name. Enter your full name (letters only):',
    ask_state: 'Enter your state (e.g. Kano):',
    invalid_state: 'Invalid state. Enter your state (e.g. Kano):',
    ask_role: `Select role:
1 Farmer
2 Student
3 Buyer
4 Supplier`,
    invalid_role: `Invalid role. Select:
1 Farmer
2 Student
3 Buyer
4 Supplier`,
    registration_done: 'Registration complete. Welcome to AgricPlatform!',
    no_prices: 'No market prices available right now. Please try again later.',
    price_prompt: 'Select crop:',
    invalid_crop: 'Invalid crop. Select a number from the list:',
    no_opportunities: 'No open opportunities right now. Please check again soon.',
    opportunities_header: 'Open opportunities:',
    ask_course_code: 'Enter the course code (from the app or SMS):',
    no_courses: 'No courses are open for enrolment right now.',
    course_not_found: 'Course not found. Enter the course code:',
    course_confirm: `Enrol in this course?
1 Yes
2 No`,
    enrolment_done: 'Enrolment confirmed. You will get an SMS shortly.',
    enrolment_cancelled: 'Enrolment cancelled.',
    invalid_confirmation: 'Reply 1 for Yes or 2 for No:',
    language_menu: `Language:
1 English`,
    language_set: 'Language is English. Hausa, Yoruba and Igbo are coming soon.',
    pulse_unavailable: 'Planting advisory is unavailable right now. Please try again later.',
    pulse_none:
      'No planting advisory subscription found for this phone. Use the app or ask your field agent to subscribe a plot.',
    wire_prompt: 'Price check — select crop:',
    wire_market_prompt: 'Select market:',
    wire_unavailable: 'Price unavailable right now. Please try again later.'
  }
};

function t(language: LanguageCode, key: StringKey): string {
  // Translation slots are scaffolded; only English ships in this wave.
  void language;
  return STRINGS.en[key];
}

export function supportedLanguages(): readonly LanguageCode[] {
  return SUPPORTED_LANGUAGES;
}

export function initialUssdState(language: LanguageCode = 'en'): UssdSessionState {
  return { menu: 'main', language, draft: {} };
}

/** Whitespace that can appear in a menu body (spaces and newlines only). */
function isMenuWhitespace(char: string): boolean {
  return char === ' ' || char === NEWLINE;
}

/**
 * Drops a trailing partial word: the trailing whitespace run plus any
 * non-whitespace run after it, mirroring the previous regex
 * `[whitespace]+[non-whitespace]*$` — unchanged when the slice ends with a
 * complete word preceded by no whitespace. Menu bodies only ever contain
 * spaces and newlines, so the behaviour is identical on all real inputs.
 */
function dropTrailingPartialWord(text: string): string {
  let wordStart = text.length;
  while (wordStart > 0 && !isMenuWhitespace(text[wordStart - 1])) {
    wordStart -= 1;
  }
  let keepEnd = wordStart;
  while (keepEnd > 0 && isMenuWhitespace(text[keepEnd - 1])) {
    keepEnd -= 1;
  }
  // No whitespace run before the tail word → nothing to drop.
  return text.slice(0, keepEnd === wordStart ? text.length : keepEnd);
}

/** Caps a response body at the turnaround limit, preserving line structure. */
export function capResponse(body: string, max: number = USSD_MAX_RESPONSE_CHARS): string {
  if (body.length <= max) {
    return body;
  }
  return dropTrailingPartialWord(body.slice(0, max - 1)).trimEnd();
}

/** Body cap so the prefixed response stays within the turnaround limit. */
const BODY_CAP = USSD_MAX_RESPONSE_CHARS - 4;

function con(state: UssdSessionState, body: string): UssdTurn {
  return { state, response: `CON ${capResponse(body, BODY_CAP)}`, end: false };
}

function end(state: UssdSessionState, body: string): UssdTurn {
  return { state, response: `END ${capResponse(body, BODY_CAP)}`, end: true };
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1} ${item}`).join(NEWLINE);
}

function formatPriceNgn(value: number): string {
  return `NGN ${Math.round(value).toLocaleString('en-NG')}`;
}

function isValidName(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z' -]{1,48}$/.test(input.trim());
}

function isValidState(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z' -]{1,29}$/.test(input.trim());
}

/** Resolves a typed course code against the catalogue (id, id suffix or 1-based index). */
export function resolveCourseCode(
  input: string,
  courses: UssdMenuData['courses']
): UssdMenuData['courses'][number] | undefined {
  const code = input.trim().toLowerCase();
  if (!code) {
    return undefined;
  }
  const index = Number.parseInt(code, 10);
  if (String(index) === code && index >= 1 && index <= courses.length) {
    return courses[index - 1];
  }
  return courses.find((course) => {
    const id = course.id.toLowerCase();
    return id === code || id.split('-').pop() === code;
  });
}

/** Quote lookup key for the Price Wire pull data (commodity¦market). */
export function wireQuoteMenuKey(commodity: string, market: string): string {
  return `${commodity}¦${market}`;
}

/**
 * Advances the machine one turn. `input` is the latest segment of the
 * Africa's Talking `text` field (empty string on the opening dial). In any
 * sub-menu, `0` navigates back to the main menu.
 */
export function handleUssdTurn(
  state: UssdSessionState,
  input: string,
  data: UssdMenuData
): UssdTurn {
  const text = input.trim();
  const lang = state.language;

  if (text === '') {
    return con(initialUssdState(lang), t(lang, 'main_menu'));
  }
  if (state.menu !== 'main' && text === '0') {
    return con({ ...initialUssdState(lang), language: state.language }, t(lang, 'main_menu'));
  }

  switch (state.menu) {
    case 'main':
      return handleMain(state, text, data);
    case 'register_name':
      return handleRegisterName(state, text);
    case 'register_state':
      return handleRegisterState(state, text);
    case 'register_role':
      return handleRegisterRole(state, text);
    case 'price_select':
      return handlePriceSelect(state, text, data);
    case 'wire_commodity':
      return handleWireCommodity(state, text, data);
    case 'wire_market':
      return handleWireMarket(state, text, data);
    case 'course_code':
      return handleCourseCode(state, text, data);
    case 'course_confirm':
      return handleCourseConfirm(state, text, data);
    case 'language':
      return handleLanguage(state, text);
  }
}

function handleMain(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  switch (text) {
    case '1':
      return con({ ...state, menu: 'register_name', draft: {} }, t(lang, 'ask_name'));
    case '2': {
      if (data.prices.length === 0) {
        return end(state, t(lang, 'no_prices'));
      }
      const crops = data.prices.slice(0, 6).map((price) => price.crop);
      return con(
        { ...state, menu: 'price_select' },
        `${t(lang, 'price_prompt')}
${numbered(crops)}`
      );
    }
    case '3': {
      const open = data.opportunities.slice(0, 3);
      if (open.length === 0) {
        return end(state, t(lang, 'no_opportunities'));
      }
      const lines = open.map((opportunity, index) => `${index + 1} ${opportunity.title}`);
      return end(state, `${t(lang, 'opportunities_header')}
${lines.join(NEWLINE)}`);
    }
    case '4': {
      if (data.courses.length === 0) {
        return end(state, t(lang, 'no_courses'));
      }
      return con({ ...state, menu: 'course_code', courseId: undefined }, t(lang, 'ask_course_code'));
    }
    case '5': {
      // Planting-Window Pulse pull: the advisory text arrives pre-rendered
      // from the advisory module; the engine never fabricates one.
      const pulse = data.plantingPulse;
      if (!pulse || !pulse.available || !pulse.text) {
        return end(
          state,
          pulse?.reason === 'no_active_subscription' ? t(lang, 'pulse_none') : t(lang, 'pulse_unavailable')
        );
      }
      return end(initialUssdState(lang), pulse.text);
    }
    case '6': {
      // Price Wire pull: commodities/markets/quotes arrive pre-computed from
      // the advisory module; the engine never fabricates a price.
      const wire = data.priceWire;
      if (!wire || wire.commodities.length === 0) {
        return end(state, t(lang, 'wire_unavailable'));
      }
      return con(
        { ...state, menu: 'wire_commodity', wireCommodity: undefined },
        `${t(lang, 'wire_prompt')}
${numbered(wire.commodities)}`
      );
    }
    case '0':
      return con({ ...state, menu: 'language' }, t(lang, 'language_menu'));
    default:
      return con(state, `${t(lang, 'invalid_choice')}
${t(lang, 'main_menu')}`);
  }
}

function handleRegisterName(state: UssdSessionState, text: string): UssdTurn {
  const lang = state.language;
  if (!isValidName(text)) {
    return con(state, t(lang, 'invalid_name'));
  }
  return con(
    { ...state, menu: 'register_state', draft: { ...state.draft, fullName: text.trim() } },
    t(lang, 'ask_state')
  );
}

function handleRegisterState(state: UssdSessionState, text: string): UssdTurn {
  const lang = state.language;
  if (!isValidState(text)) {
    return con(state, t(lang, 'invalid_state'));
  }
  return con(
    { ...state, menu: 'register_role', draft: { ...state.draft, state: text.trim() } },
    t(lang, 'ask_role')
  );
}

function handleRegisterRole(state: UssdSessionState, text: string): UssdTurn {
  const lang = state.language;
  const index = Number.parseInt(text, 10);
  const role = USSD_REGISTRATION_ROLES[index - 1];
  const { fullName, state: homeState } = state.draft;
  if (!role || !fullName || !homeState) {
    return con(state, t(lang, 'invalid_role'));
  }
  return {
    state: initialUssdState(lang),
    response: `END ${t(lang, 'registration_done')}`,
    end: true,
    effect: { type: 'register', fullName, state: homeState, role }
  };
}

function handlePriceSelect(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  const crops = data.prices.slice(0, 6);
  const index = Number.parseInt(text, 10);
  const price = crops[index - 1];
  if (!price) {
    return con(
      state,
      `${t(lang, 'invalid_crop')}
${numbered(crops.map((entry) => entry.crop))}`
    );
  }
  const day = price.observedAt.slice(0, 10);
  return end(
    initialUssdState(lang),
    `${price.crop}: ${formatPriceNgn(price.priceNgn)}
${price.market} (${price.state})
${day}`
  );
}

function handleWireCommodity(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  const wire = data.priceWire;
  const commodities = wire?.commodities ?? [];
  const index = Number.parseInt(text, 10);
  const commodity = commodities[index - 1];
  if (!wire || !commodity) {
    return con(
      state,
      `${t(lang, 'invalid_crop')}
${numbered(commodities)}`
    );
  }
  const markets = wire.markets[commodity] ?? [];
  if (markets.length === 0) {
    return end(state, t(lang, 'wire_unavailable'));
  }
  return con(
    { ...state, menu: 'wire_market', wireCommodity: commodity },
    `${t(lang, 'wire_market_prompt')}
${numbered(markets)}`
  );
}

function handleWireMarket(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  const wire = data.priceWire;
  const commodity = state.wireCommodity;
  const markets = (wire && commodity ? wire.markets[commodity] : undefined) ?? [];
  const index = Number.parseInt(text, 10);
  const market = markets[index - 1];
  if (!wire || !commodity || !market) {
    return con(
      state,
      `${t(lang, 'invalid_choice')}
${numbered(markets)}`
    );
  }
  const quote = wire.quotes[wireQuoteMenuKey(commodity, market)];
  if (!quote || !quote.available || !quote.text) {
    // Honest pull answer: stale/stub/unavailable feeds never render a number.
    return end(initialUssdState(lang), t(lang, 'wire_unavailable'));
  }
  return end(initialUssdState(lang), quote.text);
}

function handleCourseCode(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  const course = resolveCourseCode(text, data.courses);
  if (!course) {
    return con(state, t(lang, 'course_not_found'));
  }
  return con(
    { ...state, menu: 'course_confirm', courseId: course.id },
    `${course.title}
${t(lang, 'course_confirm')}`
  );
}

function handleCourseConfirm(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  const course = data.courses.find((entry) => entry.id === state.courseId);
  if (!course) {
    // Catalogue changed mid-session; restart rather than enrol blindly.
    return end(initialUssdState(lang), t(lang, 'no_courses'));
  }
  if (text === '1') {
    return {
      state: initialUssdState(lang),
      response: `END ${capResponse(`${t(lang, 'enrolment_done')} ${course.title}`, BODY_CAP)}`,
      end: true,
      effect: { type: 'enrol', courseId: course.id, courseTitle: course.title }
    };
  }
  if (text === '2') {
    return end(initialUssdState(lang), t(lang, 'enrolment_cancelled'));
  }
  return con(state, `${course.title}
${t(lang, 'invalid_confirmation')}`);
}

function handleLanguage(state: UssdSessionState, text: string): UssdTurn {
  const lang = state.language;
  if (text === '1') {
    return end(initialUssdState(lang), t(lang, 'language_set'));
  }
  return con(state, `${t(lang, 'invalid_choice')}
${t(lang, 'language_menu')}`);
}
