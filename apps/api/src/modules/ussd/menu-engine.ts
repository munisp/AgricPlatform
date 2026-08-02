import type { LanguageCode } from '@agric-platform/shared';

/**
 * USSD menu engine (wave P5b) — a pure, deterministic state machine for
 * Africa's Talking sessions. Every response is prefixed CON (session
 * continues) or END (session closes) and capped at 182 characters so it fits
 * one feature-phone screen. The engine never performs I/O: the caller passes
 * the current state, the latest input segment and the data the menu needs,
 * and receives the next state, the full response text and an optional side
 * effect (registration/enrolment) for the service layer to execute.
 */

/** Africa's Talking turnaround limit for one USSD screen. */
export const USSD_MAX_RESPONSE_CHARS = 182;

/** Roles offered during USSD self-registration (KYC tier 0 phone identity). */
export const USSD_REGISTRATION_ROLES = ['farmer', 'student', 'buyer', 'supplier'] as const;
export type UssdRegistrationRole = (typeof USSD_REGISTRATION_ROLES)[number];

export type UssdMenuId =
  | 'main'
  | 'register_name'
  | 'register_state'
  | 'register_role'
  | 'price_select'
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
  | 'language_set';

const STRINGS: Record<'en', Record<StringKey, string>> = {
  en: {
    main_menu:
      'Welcome to AgricPlatform\n1 Register\n2 Market prices\n3 Opportunities\n4 Course enrolment\n0 Language',
    invalid_choice: 'Invalid choice.',
    ask_name: 'Enter your full name:',
    invalid_name: 'Invalid name. Enter your full name (letters only):',
    ask_state: 'Enter your state (e.g. Kano):',
    invalid_state: 'Invalid state. Enter your state (e.g. Kano):',
    ask_role: 'Select role:\n1 Farmer\n2 Student\n3 Buyer\n4 Supplier',
    invalid_role: 'Invalid role. Select:\n1 Farmer\n2 Student\n3 Buyer\n4 Supplier',
    registration_done: 'Registration complete. Welcome to AgricPlatform!',
    no_prices: 'No market prices available right now. Please try again later.',
    price_prompt: 'Select crop:',
    invalid_crop: 'Invalid crop. Select a number from the list:',
    no_opportunities: 'No open opportunities right now. Please check again soon.',
    opportunities_header: 'Open opportunities:',
    ask_course_code: 'Enter the course code (from the app or SMS):',
    no_courses: 'No courses are open for enrolment right now.',
    course_not_found: 'Course not found. Enter the course code:',
    course_confirm: 'Enrol in this course?\n1 Yes\n2 No',
    enrolment_done: 'Enrolment confirmed. You will get an SMS shortly.',
    enrolment_cancelled: 'Enrolment cancelled.',
    invalid_confirmation: 'Reply 1 for Yes or 2 for No:',
    language_menu: 'Language:\n1 English',
    language_set: 'Language is English. Hausa, Yoruba and Igbo are coming soon.'
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

/** Caps a response body at the turnaround limit, preserving line structure. */
export function capResponse(body: string, max: number = USSD_MAX_RESPONSE_CHARS): string {
  if (body.length <= max) {
    return body;
  }
  return body
    .slice(0, max - 1)
    .replace(/[\n\s]+\S*$/, '')
    .trimEnd();
}

function con(state: UssdSessionState, body: string): UssdTurn {
  return { state, response: `CON ${capResponse(body)}`, end: false };
}

function end(state: UssdSessionState, body: string): UssdTurn {
  return { state, response: `END ${capResponse(body)}`, end: true };
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1} ${item}`).join('\n');
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
        `${t(lang, 'price_prompt')}\n${numbered(crops)}`
      );
    }
    case '3': {
      const open = data.opportunities.slice(0, 3);
      if (open.length === 0) {
        return end(state, t(lang, 'no_opportunities'));
      }
      const lines = open.map((opportunity, index) => `${index + 1} ${opportunity.title}`);
      return end(state, `${t(lang, 'opportunities_header')}\n${lines.join('\n')}`);
    }
    case '4': {
      if (data.courses.length === 0) {
        return end(state, t(lang, 'no_courses'));
      }
      return con({ ...state, menu: 'course_code', courseId: undefined }, t(lang, 'ask_course_code'));
    }
    case '0':
      return con({ ...state, menu: 'language' }, t(lang, 'language_menu'));
    default:
      return con(state, `${t(lang, 'invalid_choice')}\n${t(lang, 'main_menu')}`);
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
      `${t(lang, 'invalid_crop')}\n${numbered(crops.map((entry) => entry.crop))}`
    );
  }
  const day = price.observedAt.slice(0, 10);
  return end(
    initialUssdState(lang),
    `${price.crop}: ${formatPriceNgn(price.priceNgn)}\n${price.market} (${price.state})\n${day}`
  );
}

function handleCourseCode(state: UssdSessionState, text: string, data: UssdMenuData): UssdTurn {
  const lang = state.language;
  const course = resolveCourseCode(text, data.courses);
  if (!course) {
    return con(state, t(lang, 'course_not_found'));
  }
  return con(
    { ...state, menu: 'course_confirm', courseId: course.id },
    `${course.title}\n${t(lang, 'course_confirm')}`
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
      response: `END ${capResponse(`${t(lang, 'enrolment_done')} ${course.title}`)}`,
      end: true,
      effect: { type: 'enrol', courseId: course.id, courseTitle: course.title }
    };
  }
  if (text === '2') {
    return end(initialUssdState(lang), t(lang, 'enrolment_cancelled'));
  }
  return con(state, `${course.title}\n${t(lang, 'invalid_confirmation')}`);
}

function handleLanguage(state: UssdSessionState, text: string): UssdTurn {
  const lang = state.language;
  if (text === '1') {
    return end(initialUssdState(lang), t(lang, 'language_set'));
  }
  return con(state, `${t(lang, 'invalid_choice')}\n${t(lang, 'language_menu')}`);
}
