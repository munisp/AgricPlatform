import { capResponse } from '../ussd/menu-engine.js';

/**
 * USSD agronomy menu engine (wave VOICE) — a pure, deterministic state
 * machine for feature-phone access to the voice agronomist. No I/O: the
 * caller passes the current state and the latest input segment and receives
 * the next state, the full CON/END response and an optional side effect
 * (`agronomy_query` for the RAG layer, `escalate` for a human agent) to
 * execute. Responses are capped at the 182-character Africa's Talking
 * turnaround limit, mirroring the wave P5b menu engine.
 */

export const USSD_AGRONOMY_CROPS = ['Maize', 'Cassava', 'Rice', 'Yam', 'Sorghum', 'Cowpea'] as const;

export interface UssdSymptomCategory {
  key: string;
  label: string;
}

export const USSD_SYMPTOM_CATEGORIES: readonly UssdSymptomCategory[] = [
  { key: 'pests', label: 'Pests and insects' },
  { key: 'disease', label: 'Disease or fungus' },
  { key: 'soil', label: 'Soil and fertilizer' },
  { key: 'water', label: 'Water and irrigation' },
  { key: 'planting', label: 'Planting and seed' }
] as const;

/** DTMF key that asks for a human agent in any sub-menu. */
export const USSD_AGENT_KEY = '9';
/** DTMF key that restarts the menu in any sub-menu. */
export const USSD_RESTART_KEY = '0';

export type UssdAgronomyMenuId = 'crop' | 'symptom';

export interface UssdAgronomyState {
  menu: UssdAgronomyMenuId;
  crop?: string;
  symptomCategory?: string;
}

export type UssdAgronomyEffect =
  | { type: 'agronomy_query'; crop: string; category: string; categoryLabel: string }
  | { type: 'escalate'; crop?: string; category?: string };

export interface UssdAgronomyTurn {
  state: UssdAgronomyState;
  /** Full response body including the CON/END prefix (≤182 chars). */
  response: string;
  end: boolean;
  effect?: UssdAgronomyEffect;
}

const BODY_CAP = 182 - 4;

function con(state: UssdAgronomyState, body: string): UssdAgronomyTurn {
  return { state, response: `CON ${capResponse(body, BODY_CAP)}`, end: false };
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1} ${item}`).join('\n');
}

export function initialAgronomyUssdState(): UssdAgronomyState {
  return { menu: 'crop' };
}

const CROP_MENU = `Voice agronomist — select crop:\n${numbered([...USSD_AGRONOMY_CROPS])}\n${USSD_AGENT_KEY} Agent`;

function symptomMenu(crop: string): string {
  return `${crop} — what is the problem?\n${numbered(USSD_SYMPTOM_CATEGORIES.map((c) => c.label))}\n${USSD_AGENT_KEY} Agent\n${USSD_RESTART_KEY} Back`;
}

/** Deterministic query string handed to the RAG layer for a menu path. */
export function agronomyQueryFor(crop: string, categoryLabel: string): string {
  return `${crop} ${categoryLabel}`;
}

/**
 * Advances the machine one turn. `input` is the latest segment of the
 * Africa's Talking `text` field (empty string on the opening dial).
 */
export function handleAgronomyUssdTurn(
  state: UssdAgronomyState,
  input: string
): UssdAgronomyTurn {
  const text = input.trim();

  if (text === '') {
    return con(initialAgronomyUssdState(), CROP_MENU);
  }
  if (state.menu !== 'crop' && text === USSD_RESTART_KEY) {
    return con(initialAgronomyUssdState(), CROP_MENU);
  }
  if (text === USSD_AGENT_KEY) {
    return {
      state: initialAgronomyUssdState(),
      response: 'END Connecting you to an agronomist. You will receive a call or SMS shortly.',
      end: true,
      effect: { type: 'escalate', crop: state.crop, category: state.symptomCategory }
    };
  }

  switch (state.menu) {
    case 'crop': {
      const index = Number.parseInt(text, 10);
      const crop = USSD_AGRONOMY_CROPS[index - 1];
      if (!crop) {
        return con(state, `Invalid choice.\n${CROP_MENU}`);
      }
      return con({ menu: 'symptom', crop }, symptomMenu(crop));
    }
    case 'symptom': {
      const index = Number.parseInt(text, 10);
      const category = USSD_SYMPTOM_CATEGORIES[index - 1];
      if (!category || !state.crop) {
        return con(state, `Invalid choice.\n${symptomMenu(state.crop ?? 'Crop')}`);
      }
      return {
        state: initialAgronomyUssdState(),
        response: 'END Finding advice for you…',
        end: true,
        effect: {
          type: 'agronomy_query',
          crop: state.crop,
          category: category.key,
          categoryLabel: category.label
        }
      };
    }
  }
}
