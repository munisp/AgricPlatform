import { describe, expect, it } from 'vitest';
import {
  capResponse,
  handleUssdTurn,
  initialUssdState,
  resolveCourseCode,
  supportedLanguages,
  USSD_MAX_RESPONSE_CHARS,
  type UssdEffect,
  type UssdMenuData,
  type UssdSessionState,
  type UssdTurn
} from './menu-engine.js';

const DATA: UssdMenuData = {
  prices: [
    { crop: 'Maize', market: 'Dawanau', state: 'Kano', priceNgn: 45000, observedAt: '2025-06-01T09:00:00.000Z' },
    { crop: 'Rice', market: 'Mile 12', state: 'Lagos', priceNgn: 78000, observedAt: '2025-06-02T09:00:00.000Z' },
    { crop: 'Sorghum', market: 'Bodija', state: 'Oyo', priceNgn: 38500, observedAt: '2025-06-03T09:00:00.000Z' }
  ],
  opportunities: [
    { id: 'opp-1', title: 'BOI Youth Agri Grant', type: 'grant', deadline: '2025-07-01' },
    { id: 'opp-2', title: 'NIRSAL Input Credit', type: 'loan', deadline: '2025-08-01' },
    { id: 'opp-3', title: 'Extension Officer Role', type: 'job', deadline: '2025-09-01' },
    { id: 'opp-4', title: 'Hidden Fourth', type: 'grant', deadline: '2025-10-01' }
  ],
  courses: [
    { id: 'course-agronomy101', title: 'Agronomy Basics' },
    { id: 'course-poultry201', title: 'Poultry Management' }
  ]
};

const EMPTY: UssdMenuData = { prices: [], opportunities: [], courses: [] };

/** Runs a sequence of inputs through the engine, returning every turn. */
function run(inputs: string[], data: UssdMenuData = DATA): UssdTurn[] {
  const turns: UssdTurn[] = [];
  let state: UssdSessionState = initialUssdState();
  for (const input of inputs) {
    const turn = handleUssdTurn(state, input, data);
    turns.push(turn);
    state = turn.state;
  }
  return turns;
}

describe('USSD menu engine', () => {
  it('opens with the main menu on empty input', () => {
    const [turn] = run(['']);
    expect(turn.end).toBe(false);
    expect(turn.response).toContain('CON ');
    expect(turn.response).toContain('1 Register');
    expect(turn.response).toContain('2 Market prices');
    expect(turn.response).toContain('3 Opportunities');
    expect(turn.response).toContain('4 Course enrolment');
    expect(turn.response).toContain('0 Language');
  });

  it('keeps every response within the 182-char turnaround limit', () => {
    const longData: UssdMenuData = {
      ...DATA,
      opportunities: [
        { id: 'o1', title: 'X'.repeat(120), type: 'grant', deadline: '2025-07-01' },
        { id: 'o2', title: 'Y'.repeat(120), type: 'loan', deadline: '2025-08-01' },
        { id: 'o3', title: 'Z'.repeat(120), type: 'job', deadline: '2025-09-01' }
      ]
    };
    for (const turn of run(['', '1', '2', '3', '4', '0'], longData)) {
      expect(turn.response.length).toBeLessThanOrEqual(USSD_MAX_RESPONSE_CHARS + 4); // +4 for "CON "
    }
  });

  it('rejects invalid main-menu input and re-shows the menu', () => {
    const [, turn] = run(['', '9']);
    expect(turn.end).toBe(false);
    expect(turn.response).toContain('Invalid choice.');
    expect(turn.response).toContain('1 Register');
  });

  describe('registration flow (main → 1)', () => {
    it('collects name, state and role, then emits a register effect', () => {
      const turns = run(['', '1', 'Amina Bello', 'Kano', '1']);
      expect(turns[1].response).toContain('Enter your full name');
      expect(turns[2].response).toContain('Enter your state');
      expect(turns[3].response).toContain('Select role');
      const final = turns[4];
      expect(final.end).toBe(true);
      expect(final.response).toContain('END Registration complete');
      expect(final.effect).toEqual({
        type: 'register',
        fullName: 'Amina Bello',
        state: 'Kano',
        role: 'farmer'
      } satisfies UssdEffect);
      expect(final.state.menu).toBe('main');
    });

    it('maps each numbered role deterministically', () => {
      const roles = ['farmer', 'student', 'buyer', 'supplier'];
      roles.forEach((expected, i) => {
        const turns = run(['', '1', 'Amina Bello', 'Kano', String(i + 1)]);
        expect(turns[4].effect).toMatchObject({ role: expected });
      });
    });

    it('rejects an invalid name and stays on the name step', () => {
      const turns = run(['', '1', '123']);
      expect(turns[2].response).toContain('Invalid name');
      expect(turns[2].state.menu).toBe('register_name');
    });

    it('rejects an invalid state and stays on the state step', () => {
      const turns = run(['', '1', 'Amina Bello', '!!']);
      expect(turns[3].response).toContain('Invalid state');
      expect(turns[3].state.menu).toBe('register_state');
    });

    it('rejects an out-of-range role and stays on the role step', () => {
      const turns = run(['', '1', 'Amina Bello', 'Kano', '9']);
      expect(turns[4].response).toContain('Invalid role');
      expect(turns[4].state.menu).toBe('register_role');
      expect(turns[4].effect).toBeUndefined();
    });
  });

  describe('price check flow (main → 2)', () => {
    it('lists crops and returns the latest price for the selection', () => {
      const turns = run(['', '2', '1']);
      expect(turns[1].response).toContain('Select crop:');
      expect(turns[1].response).toContain('1 Maize');
      expect(turns[1].response).toContain('2 Rice');
      const final = turns[2];
      expect(final.end).toBe(true);
      expect(final.response).toContain('Maize: NGN 45,000');
      expect(final.response).toContain('Dawanau (Kano)');
      expect(final.response).toContain('2025-06-01');
    });

    it('rejects an out-of-range crop selection and re-lists', () => {
      const turns = run(['', '2', '9']);
      expect(turns[2].end).toBe(false);
      expect(turns[2].response).toContain('Invalid crop');
      expect(turns[2].response).toContain('1 Maize');
    });

    it('ends cleanly when no prices are available', () => {
      const turns = run(['', '2'], EMPTY);
      expect(turns[1].end).toBe(true);
      expect(turns[1].response).toContain('No market prices');
    });
  });

  describe('opportunities flow (main → 3)', () => {
    it('shows only the first three open opportunities, numbered', () => {
      const turns = run(['', '3']);
      const final = turns[1];
      expect(final.end).toBe(true);
      expect(final.response).toContain('1 BOI Youth Agri Grant');
      expect(final.response).toContain('2 NIRSAL Input Credit');
      expect(final.response).toContain('3 Extension Officer Role');
      expect(final.response).not.toContain('Hidden Fourth');
    });

    it('ends cleanly when nothing is open', () => {
      const turns = run(['', '3'], EMPTY);
      expect(turns[1].response).toContain('No open opportunities');
    });
  });

  describe('course enrolment flow (main → 4)', () => {
    it('confirms enrolment after a valid course code', () => {
      const turns = run(['', '4', 'agronomy101', '1']);
      expect(turns[1].response).toContain('Enter the course code');
      expect(turns[2].response).toContain('Agronomy Basics');
      expect(turns[2].response).toContain('1 Yes');
      const final = turns[3];
      expect(final.end).toBe(true);
      expect(final.response).toContain('Enrolment confirmed');
      expect(final.effect).toEqual({
        type: 'enrol',
        courseId: 'course-agronomy101',
        courseTitle: 'Agronomy Basics'
      } satisfies UssdEffect);
    });

    it('cancels enrolment on No', () => {
      const turns = run(['', '4', 'poultry201', '2']);
      expect(turns[3].end).toBe(true);
      expect(turns[3].response).toContain('Enrolment cancelled');
      expect(turns[3].effect).toBeUndefined();
    });

    it('re-prompts on an unknown course code', () => {
      const turns = run(['', '4', 'nosuchcourse']);
      expect(turns[2].response).toContain('Course not found');
      expect(turns[2].state.menu).toBe('course_code');
    });

    it('re-prompts on an invalid confirmation answer', () => {
      const turns = run(['', '4', 'agronomy101', '7']);
      expect(turns[3].response).toContain('Reply 1 for Yes or 2 for No');
      expect(turns[3].state.menu).toBe('course_confirm');
    });

    it('ends cleanly when the catalogue is empty', () => {
      const turns = run(['', '4'], EMPTY);
      expect(turns[1].response).toContain('No courses are open');
    });
  });

  describe('language toggle stub (main → 0)', () => {
    it('offers English only and confirms the selection', () => {
      const turns = run(['', '0', '1']);
      expect(turns[1].response).toContain('Language:');
      expect(turns[2].end).toBe(true);
      expect(turns[2].response).toContain('Language is English');
      expect(supportedLanguages()).toEqual(['en']);
    });
  });

  describe('navigation helpers', () => {
    it('returns to the main menu from any sub-menu on 0', () => {
      const turns = run(['', '1', 'Amina Bello', '0']);
      expect(turns[3].response).toContain('1 Register');
      expect(turns[3].state.menu).toBe('main');
      expect(turns[3].state.draft).toEqual({});
    });

    it('resets to the main menu on empty input mid-flow (provider redial)', () => {
      const turns = run(['', '1', '']);
      expect(turns[2].state.menu).toBe('main');
    });
  });

  describe('pure helpers', () => {
    it('capResponse truncates on a word boundary under the limit', () => {
      const body = 'word '.repeat(60).trim();
      const capped = capResponse(body);
      expect(capped.length).toBeLessThanOrEqual(USSD_MAX_RESPONSE_CHARS - 1);
      expect(body.startsWith(capped)).toBe(true);
    });

    it('resolveCourseCode matches id, id suffix and 1-based index', () => {
      expect(resolveCourseCode('course-agronomy101', DATA.courses)?.id).toBe('course-agronomy101');
      expect(resolveCourseCode('AGRONOMY101', DATA.courses)?.id).toBe('course-agronomy101');
      expect(resolveCourseCode('2', DATA.courses)?.id).toBe('course-poultry201');
      expect(resolveCourseCode('99', DATA.courses)).toBeUndefined();
      expect(resolveCourseCode('', DATA.courses)).toBeUndefined();
    });
  });
});
