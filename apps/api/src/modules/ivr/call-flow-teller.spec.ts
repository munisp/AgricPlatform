import { describe, expect, it } from 'vitest';
import {
  handleIvrTurn,
  initialIvrState,
  mainMenuPrompt,
  PROMPTS,
  type IvrMenuData
} from './call-flow.js';

/**
 * Voice Teller call-flow engine tests (Stage 27, Innovation 6): the
 * account menu nodes are pure and deterministic — the engine resolves
 * grammar-slot intents and validates PIN FORMAT only; verification and
 * account answers stay in the service layer (voice-intent effect).
 */

const DATA: IvrMenuData = { prices: [] };
const TELLER_ON: IvrMenuData = {
  prices: [],
  voiceTeller: { enabled: true, registered: true, locale: 'en' }
};

describe('flag-gated account menu', () => {
  it('the main menu speaks the account option only when the flag is on', () => {
    expect(mainMenuPrompt(DATA)).toBe(PROMPTS.main_menu);
    expect(mainMenuPrompt(TELLER_ON)).toContain('Press 5 for your account services.');
  });

  it('opening ring with flag ON offers account services; OFF is byte-identical to pre-teller', () => {
    const on = handleIvrTurn(initialIvrState(), undefined, TELLER_ON);
    const off = handleIvrTurn(initialIvrState(), undefined, DATA);
    expect(on.actions[1]).toMatchObject({ type: 'getDigits' });
    const onPrompt = on.actions[1].type === 'getDigits' ? on.actions[1].prompt : '';
    const offPrompt = off.actions[1].type === 'getDigits' ? off.actions[1].prompt : '';
    expect(onPrompt).toContain('account services');
    expect(offPrompt).toBe(PROMPTS.main_menu);
  });

  it('5 with flag OFF is an invalid choice (account menu unreachable)', () => {
    const turn = handleIvrTurn(initialIvrState(), '5', DATA);
    expect(turn.state.menu).toBe('main');
    expect(turn.state.strikes).toBe(1);
    expect(turn.actions[0]).toEqual({ type: 'say', text: PROMPTS.invalid_choice });
  });

  it('5 with flag ON but unregistered caller hears the registration prompt', () => {
    const turn = handleIvrTurn(initialIvrState(), '5', {
      prices: [],
      voiceTeller: { enabled: true, registered: false }
    });
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).toEqual({ type: 'say', text: PROMPTS.not_registered });
  });
});

describe('account menu → PIN flow', () => {
  it('5 enters the account menu', () => {
    const turn = handleIvrTurn(initialIvrState(), '5', TELLER_ON);
    expect(turn.state.menu).toBe('account_menu');
    expect(turn.actions[0]).toMatchObject({ type: 'getDigits' });
    const prompt = turn.actions[0].type === 'getDigits' ? turn.actions[0].prompt : '';
    expect(prompt).toContain('Press 1 for your savings balance');
    expect(prompt).toContain('Press 5 for your voucher status');
  });

  it.each([
    ['1', 'balance.savings'],
    ['2', 'balance.float'],
    ['3', 'loan.next_installment'],
    ['4', 'vsla.position'],
    ['5', 'voucher.status']
  ])('account digit %s arms intent %s and asks for the PIN', (digit, intent) => {
    const menu = handleIvrTurn(initialIvrState(), '5', TELLER_ON);
    const turn = handleIvrTurn(menu.state, digit, TELLER_ON);
    expect(turn.state.menu).toBe('account_pin');
    expect(turn.state.pendingIntent).toBe(intent);
    expect(turn.actions[0]).toEqual({
      type: 'getDigits',
      prompt: PROMPTS.account_pin,
      timeoutSeconds: 10,
      numDigits: 4
    });
  });

  it('a 4-digit PIN emits the voice_intent effect (service resolves it)', () => {
    const menu = handleIvrTurn(initialIvrState(), '5', TELLER_ON);
    const pin = handleIvrTurn(menu.state, '3', TELLER_ON);
    const turn = handleIvrTurn(pin.state, '4321', TELLER_ON);
    expect(turn.effect).toEqual({ type: 'voice_intent', intent: 'loan.next_installment', pin: '4321' });
    expect(turn.actions).toEqual([]); // engine never answers account questions
    expect(turn.end).toBe(false);
  });

  it('a malformed PIN is a strike + format re-prompt (never an effect)', () => {
    const menu = handleIvrTurn(initialIvrState(), '5', TELLER_ON);
    const pin = handleIvrTurn(menu.state, '1', TELLER_ON);
    const turn = handleIvrTurn(pin.state, '12a4', TELLER_ON);
    expect(turn.effect).toBeUndefined();
    expect(turn.state.strikes).toBe(1);
    expect(turn.actions[0]).toEqual({ type: 'say', text: PROMPTS.pin_invalid_format });
  });

  it('three strikes in the PIN menu end the call abandoned', () => {
    const menu = handleIvrTurn(initialIvrState(), '5', TELLER_ON);
    let turn = handleIvrTurn(menu.state, '1', TELLER_ON);
    turn = handleIvrTurn(turn.state, 'ab', TELLER_ON);
    turn = handleIvrTurn(turn.state, 'cd', TELLER_ON);
    turn = handleIvrTurn(turn.state, 'ef', TELLER_ON);
    expect(turn.end).toBe(true);
    expect(turn.outcome).toBe('abandoned');
  });

  it('0 in the account menu escalates; 9 repeats the account menu', () => {
    const menu = handleIvrTurn(initialIvrState(), '5', TELLER_ON);
    const esc = handleIvrTurn(menu.state, '0', TELLER_ON);
    expect(esc.outcome).toBe('escalated');
    expect(esc.actions[1]).toEqual({ type: 'enqueue' });
    const repeat = handleIvrTurn(menu.state, '9', TELLER_ON);
    expect(repeat.state.menu).toBe('account_menu');
    expect(repeat.state.strikes).toBe(0);
  });

  it('a PIN turn with no pending intent defensively restarts the main menu', () => {
    const turn = handleIvrTurn({ menu: 'account_pin', strikes: 0 }, '4321', TELLER_ON);
    expect(turn.effect).toBeUndefined();
    expect(turn.state.menu).toBe('main');
  });
});
