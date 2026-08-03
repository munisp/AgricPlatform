import { describe, expect, it } from 'vitest';
import {
  handleAgentUssdTurn,
  initialAgentUssdState,
  type AgentUssdMenuData
} from './agent-ussd.js';

const DATA: AgentUssdMenuData = {
  floatBalanceNaira: 152_000,
  lowFloat: false,
  recentTransactions: [
    { type: 'cash_in', amountNaira: 5_000, day: '2026-02-03' },
    { type: 'cash_out', amountNaira: 2_500, day: '2026-02-03' },
    { type: 'voucher_redemption', amountNaira: 1_000, day: '2026-02-02' }
  ]
};

describe('agent-banking USSD menu engine', () => {
  it('opens with the main menu (CON, ≤182 chars)', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '', DATA);
    expect(turn.end).toBe(false);
    expect(turn.response).toContain('CON');
    expect(turn.response).toContain('Float balance');
    expect(turn.response.length).toBeLessThanOrEqual(182);
  });

  it('reports the float balance and closes', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '1', DATA);
    expect(turn.end).toBe(true);
    expect(turn.response).toContain('END');
    expect(turn.response).toContain('152,000');
    expect(turn.response).not.toContain('LOW FLOAT');
  });

  it('flags a low float on the balance screen', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '1', { ...DATA, lowFloat: true });
    expect(turn.response).toContain('LOW FLOAT');
  });

  it('handles an unavailable float balance gracefully', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '1', {});
    expect(turn.end).toBe(true);
    expect(turn.response).toContain('unavailable');
  });

  it('lists the last transactions (up to 5)', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '2', DATA);
    expect(turn.end).toBe(true);
    expect(turn.response).toContain('Cash-in');
    expect(turn.response).toContain('Cash-out');
    expect(turn.response).toContain('Voucher');
    expect(turn.response.length).toBeLessThanOrEqual(182);
  });

  it('reports an empty transaction history', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '2', { recentTransactions: [] });
    expect(turn.end).toBe(true);
    expect(turn.response).toContain('No transactions');
  });

  it('walks the voucher redemption flow to an effect', () => {
    const ask = handleAgentUssdTurn(initialAgentUssdState(), '3', DATA);
    expect(ask.end).toBe(false);
    expect(ask.response).toContain('voucher code');

    const confirm = handleAgentUssdTurn(ask.state, 'voucher-abc-123', DATA);
    expect(confirm.end).toBe(false);
    expect(confirm.response).toContain('Redeem voucher voucher-abc-123');

    const yes = handleAgentUssdTurn(confirm.state, '1', DATA);
    expect(yes.end).toBe(true);
    expect(yes.effect).toEqual({ type: 'redeem_voucher', voucherCode: 'voucher-abc-123' });
  });

  it('cancels voucher redemption on 2', () => {
    const ask = handleAgentUssdTurn(initialAgentUssdState(), '3', DATA);
    const confirm = handleAgentUssdTurn(ask.state, 'voucher-abc-123', DATA);
    const no = handleAgentUssdTurn(confirm.state, '2', DATA);
    expect(no.end).toBe(true);
    expect(no.effect).toBeUndefined();
    expect(no.response).toContain('cancelled');
  });

  it('rejects malformed voucher codes and stays in the menu', () => {
    const ask = handleAgentUssdTurn(initialAgentUssdState(), '3', DATA);
    const bad = handleAgentUssdTurn(ask.state, '!!', DATA);
    expect(bad.end).toBe(false);
    expect(bad.response).toContain('Invalid code');
  });

  it('re-prompts on an invalid confirmation answer', () => {
    const ask = handleAgentUssdTurn(initialAgentUssdState(), '3', DATA);
    const confirm = handleAgentUssdTurn(ask.state, 'voucher-abc-123', DATA);
    const retry = handleAgentUssdTurn(confirm.state, '7', DATA);
    expect(retry.end).toBe(false);
    expect(retry.response).toContain('Reply 1 for Yes or 2 for No');
  });

  it('returns to the main menu on 0 from a sub-menu', () => {
    const ask = handleAgentUssdTurn(initialAgentUssdState(), '3', DATA);
    const back = handleAgentUssdTurn(ask.state, '0', DATA);
    expect(back.response).toContain('Float balance');
    expect(back.state.menu).toBe('main');
  });

  it('rejects invalid main-menu choices', () => {
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '9', DATA);
    expect(turn.end).toBe(false);
    expect(turn.response).toContain('Invalid choice');
  });

  it('keeps every response within the 182-char turnaround limit', () => {
    const longData: AgentUssdMenuData = {
      recentTransactions: Array.from({ length: 5 }, (_, i) => ({
        type: 'cash_in' as const,
        amountNaira: 999_999,
        day: `2026-02-0${i + 1}`
      }))
    };
    const turn = handleAgentUssdTurn(initialAgentUssdState(), '2', longData);
    expect(turn.response.length).toBeLessThanOrEqual(182);
  });
});
