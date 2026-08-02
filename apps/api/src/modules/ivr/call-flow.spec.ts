import { describe, expect, it } from 'vitest';
import {
  formatKycTier,
  handleIvrTurn,
  initialIvrState,
  IVR_GET_DIGITS_TIMEOUT_SECONDS,
  IVR_MAX_STRIKES,
  PROMPTS,
  type IvrCallState,
  type IvrMenuData,
  type IvrTurn
} from './call-flow.js';
import { emptyVoiceXml, escapeXml, renderVoiceXml } from './voice-xml.js';

const DATA: IvrMenuData = {
  prices: [
    { crop: 'Maize', market: 'Dawanau', state: 'Kano', priceNgn: 47000, observedAt: '2025-06-05T09:00:00.000Z' },
    { crop: 'Rice', market: 'Mile 12', state: 'Lagos', priceNgn: 78000, observedAt: '2025-06-02T09:00:00.000Z' }
  ],
  advisory: { title: 'Maize planting window', summary: 'Plant early maize this week.', kind: 'crop_calendar' },
  caller: {
    fullName: 'Amina Bello',
    kycTier: 'tier_2',
    profileCompleteness: 80,
    enrolments: { total: 3, inProgress: 2, completed: 1 }
  }
};

const EMPTY: IvrMenuData = { prices: [] };

/** Runs a sequence of digit inputs through the engine, returning every turn. */
function run(inputs: Array<string | undefined>, data: IvrMenuData = DATA): IvrTurn[] {
  const turns: IvrTurn[] = [];
  let state: IvrCallState = initialIvrState();
  for (const input of inputs) {
    const turn = handleIvrTurn(state, input, data);
    turns.push(turn);
    state = turn.state;
  }
  return turns;
}

function sayTexts(turn: IvrTurn): string {
  return turn.actions
    .filter((action) => action.type === 'say' || action.type === 'getDigits')
    .map((action) => (action.type === 'say' ? action.text : action.prompt))
    .join(' ');
}

describe('handleIvrTurn — opening and main menu', () => {
  it('opens with a welcome Say and a 5-second GetDigits main menu', () => {
    const [turn] = run([undefined]);
    expect(turn.end).toBe(false);
    expect(turn.state).toEqual({ menu: 'main', strikes: 0 });
    const [welcome, ask] = turn.actions;
    expect(welcome).toEqual({ type: 'say', text: PROMPTS.welcome });
    expect(ask).toMatchObject({
      type: 'getDigits',
      prompt: PROMPTS.main_menu,
      timeoutSeconds: IVR_GET_DIGITS_TIMEOUT_SECONDS,
      numDigits: 1
    });
    expect(ask.type === 'getDigits' && ask.timeoutSeconds).toBe(5);
  });

  it('offers the crop list on option 1 and moves to price_select', () => {
    const [, pick] = run([undefined, '1']);
    expect(pick.state.menu).toBe('price_select');
    expect(pick.state.strikes).toBe(0);
    expect(pick.end).toBe(false);
    const prompt = sayTexts(pick);
    expect(prompt).toContain('Press 1 for Maize.');
    expect(prompt).toContain('Press 2 for Rice.');
  });

  it('ends politely on option 1 when no prices exist', () => {
    const [, turn] = run([undefined, '1'], EMPTY);
    expect(turn.end).toBe(true);
    expect(turn.outcome).toBe('completed');
    expect(sayTexts(turn)).toContain('no market prices');
  });

  it('repeats the main menu on 9 without touching the strike counter', () => {
    const [, , repeat] = run([undefined, '7', '9']);
    expect(repeat.end).toBe(false);
    expect(repeat.state.menu).toBe('main');
    expect(repeat.state.strikes).toBe(1); // one invalid entry before the repeat
    expect(repeat.actions[0]).toMatchObject({ type: 'getDigits', prompt: PROMPTS.main_menu });
  });

  it('escalates to an agent on 0 (Say + Enqueue + callback effect)', () => {
    const [, turn] = run([undefined, '0']);
    expect(turn.end).toBe(true);
    expect(turn.outcome).toBe('escalated');
    expect(turn.effect).toEqual({ type: 'callback_request' });
    expect(turn.actions.map((action) => action.type)).toEqual(['say', 'enqueue']);
    expect(sayTexts(turn)).toContain('agent');
  });
});

describe('handleIvrTurn — commodity price branch', () => {
  it('says the latest price for the selected crop and ends', () => {
    const [, , price] = run([undefined, '1', '1']);
    expect(price.end).toBe(true);
    expect(price.outcome).toBe('completed');
    const text = sayTexts(price);
    expect(text).toContain('Maize is 47,000 naira');
    expect(text).toContain('Dawanau market, Kano');
    expect(text).toContain('2025-06-05');
  });

  it('re-prompts on an out-of-range crop digit', () => {
    const [, , turn] = run([undefined, '1', '9']);
    expect(turn.end).toBe(false);
    expect(turn.state).toEqual({ menu: 'price_select', strikes: 1 });
    expect(sayTexts(turn)).toContain(PROMPTS.invalid_crop);
  });

  it('returns to the main menu state after a completed price check', () => {
    const [, , price] = run([undefined, '1', '2']);
    expect(price.state).toEqual(initialIvrState());
  });
});

describe('handleIvrTurn — advisory branch', () => {
  it('says the latest advisory and ends', () => {
    const [, turn] = run([undefined, '2']);
    expect(turn.end).toBe(true);
    expect(turn.outcome).toBe('completed');
    const text = sayTexts(turn);
    expect(text).toContain('Maize planting window');
    expect(text).toContain('Plant early maize this week.');
  });

  it('ends politely when no advisory is available', () => {
    const [, turn] = run([undefined, '2'], EMPTY);
    expect(turn.end).toBe(true);
    expect(sayTexts(turn)).toContain('no crop advisory');
  });
});

describe('handleIvrTurn — status branches', () => {
  it('says KYC tier and profile completeness for a known caller', () => {
    const [, turn] = run([undefined, '3']);
    expect(turn.end).toBe(true);
    const text = sayTexts(turn);
    expect(text).toContain('Amina Bello');
    expect(text).toContain('tier 2');
    expect(text).toContain('80 percent');
  });

  it('tells an unknown caller to register first (option 3)', () => {
    const [, turn] = run([undefined, '3'], EMPTY);
    expect(turn.end).toBe(true);
    expect(sayTexts(turn)).toContain('not registered');
  });

  it('summarises course enrolments for a known caller', () => {
    const [, turn] = run([undefined, '4']);
    expect(turn.end).toBe(true);
    const text = sayTexts(turn);
    expect(text).toContain('enrolled in 3 courses');
    expect(text).toContain('2 in progress');
    expect(text).toContain('1 completed');
  });

  it('reports no courses for a known caller without enrolments', () => {
    const data: IvrMenuData = {
      ...DATA,
      caller: { ...DATA.caller!, enrolments: { total: 0, inProgress: 0, completed: 0 } }
    };
    const [, turn] = run([undefined, '4'], data);
    expect(sayTexts(turn)).toContain('not enrolled in any courses');
  });

  it('tells an unknown caller to register first (option 4)', () => {
    const [, turn] = run([undefined, '4'], EMPTY);
    expect(turn.end).toBe(true);
    expect(sayTexts(turn)).toContain('not registered');
  });
});

describe('handleIvrTurn — invalid input and timeouts', () => {
  it('re-prompts once on an invalid digit', () => {
    const [, turn] = run([undefined, 'x']);
    expect(turn.end).toBe(false);
    expect(turn.state.strikes).toBe(1);
    expect(sayTexts(turn)).toContain(PROMPTS.invalid_choice);
  });

  it('counts an empty timeout as a strike and re-prompts', () => {
    const [, turn] = run([undefined, '']);
    expect(turn.end).toBe(false);
    expect(turn.state.strikes).toBe(1);
    expect(sayTexts(turn)).toContain(PROMPTS.no_input);
  });

  it('ends politely after three consecutive invalid entries', () => {
    const turns = run([undefined, 'x', 'y', 'z']);
    const last = turns[turns.length - 1];
    expect(turns[1].state.strikes).toBe(1);
    expect(turns[2].state.strikes).toBe(2);
    expect(last.end).toBe(true);
    expect(last.outcome).toBe('abandoned');
    expect(last.state.strikes).toBe(IVR_MAX_STRIKES);
    expect(sayTexts(last)).toContain('Too many invalid entries');
    // Terminal turn has no GetDigits — the call ends after the Say.
    expect(last.actions.every((action) => action.type === 'say')).toBe(true);
  });

  it('ends politely after three consecutive timeouts', () => {
    const turns = run([undefined, '', '', '']);
    const last = turns[turns.length - 1];
    expect(last.end).toBe(true);
    expect(last.outcome).toBe('abandoned');
  });

  it('resets the strike counter when a valid branch is chosen', () => {
    const [, , pick] = run([undefined, 'x', '1']);
    expect(pick.state).toEqual({ menu: 'price_select', strikes: 0 });
  });
});

describe('formatKycTier', () => {
  it('renders voice-friendly tier labels', () => {
    expect(formatKycTier('tier_0')).toBe('tier 0');
    expect(formatKycTier('tier_3')).toBe('tier 3');
  });
});

describe('voice XML rendering', () => {
  it('escapes the five XML-sensitive characters', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('renders Say and GetDigits actions inside a Response document', () => {
    const xml = renderVoiceXml([
      { type: 'say', text: 'Welcome & hello <farmers>' },
      { type: 'getDigits', prompt: 'Press 1', timeoutSeconds: 5, numDigits: 1 }
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml.endsWith('</Response>')).toBe(true);
    expect(xml).toContain('<Say>Welcome &amp; hello &lt;farmers&gt;</Say>');
    expect(xml).toContain('<GetDigits timeout="5" numDigits="1"><Say>Press 1</Say></GetDigits>');
  });

  it('renders Enqueue and Reject actions', () => {
    expect(renderVoiceXml([{ type: 'enqueue' }])).toContain('<Enqueue/>');
    expect(renderVoiceXml([{ type: 'reject' }])).toContain('<Reject/>');
  });

  it('renders an empty Response for hangup notifications', () => {
    expect(emptyVoiceXml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
});
