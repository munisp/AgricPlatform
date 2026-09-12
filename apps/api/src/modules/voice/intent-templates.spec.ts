import { describe, expect, it } from 'vitest';
import {
  renderIntentAnswer,
  renderNotRegistered,
  renderPinLocked,
  renderPinNotSet,
  renderPinWrong,
  renderUnavailable
} from './intent-templates.js';

/**
 * Voice Teller template known-answer tests (Stage 27, Innovation 6): slot
 * rendering incl. kobo → naira speech and per-locale numbers/glue. Every
 * spoken number below was "read from a read model" (passed as a slot) —
 * templates never generate values.
 */

describe('renderIntentAnswer — balance.savings', () => {
  it('renders the balance in every locale', () => {
    const answer = { intent: 'balance.savings', kind: 'ok', balanceKobo: 123456 } as const;
    expect(renderIntentAnswer(answer, 'en')).toBe('Your savings balance is 1,234 naira and 56 kobo.');
    expect(renderIntentAnswer(answer, 'ha')).toBe('Balankin ajiyar ku shine 1,234 naira da 56 kobo.');
    expect(renderIntentAnswer(answer, 'yo')).toBe('Balanse ifowopamo yin je 1,234 naira ati 56 kobo.');
    expect(renderIntentAnswer(answer, 'ig')).toBe('Ego echekwara gi bu 1,234 naira na 56 kobo.');
  });

  it('renders the no-account answer', () => {
    expect(renderIntentAnswer({ intent: 'balance.savings', kind: 'no_account' }, 'en')).toContain(
      'do not have a savings account'
    );
  });
});

describe('renderIntentAnswer — balance.float', () => {
  it('renders the agent float balance', () => {
    expect(
      renderIntentAnswer({ intent: 'balance.float', kind: 'ok', balanceKobo: 2500000 }, 'en')
    ).toBe('Your agent float balance is 25,000 naira.');
  });

  it('tells non-agents there is no float account', () => {
    expect(renderIntentAnswer({ intent: 'balance.float', kind: 'not_agent' }, 'en')).toContain(
      'not registered as an agent'
    );
  });
});

describe('renderIntentAnswer — loan.next_installment', () => {
  it('renders amount + due date per locale', () => {
    const answer = {
      intent: 'loan.next_installment',
      kind: 'ok',
      amountKobo: 1575050,
      dueAt: '2026-10-05T00:00:00.000Z'
    } as const;
    expect(renderIntentAnswer(answer, 'en')).toBe(
      'Your next loan installment is 15,750 naira and 50 kobo, due on 5 October 2026.'
    );
    expect(renderIntentAnswer(answer, 'ha')).toBe(
      'Biyan bashi na gaba shine 15,750 naira da 50 kobo, ranar biya ita ce 5 Oktoba 2026.'
    );
    expect(renderIntentAnswer(answer, 'ig')).toBe(
      'Ugwo mgbinye esote bu 15,750 naira na 50 kobo, ubochi i kwu bu 5 Oktoba 2026.'
    );
  });

  it('renders no-active-loan and all-paid answers', () => {
    expect(
      renderIntentAnswer({ intent: 'loan.next_installment', kind: 'no_active_loan' }, 'en')
    ).toBe('You have no active loan right now.');
    expect(
      renderIntentAnswer({ intent: 'loan.next_installment', kind: 'no_installment' }, 'en')
    ).toContain('already paid');
  });
});

describe('renderIntentAnswer — vsla.position', () => {
  it('renders group count + total', () => {
    expect(
      renderIntentAnswer({ intent: 'vsla.position', kind: 'ok', groupCount: 2, totalKobo: 800000 }, 'en')
    ).toBe('Your V S L A savings position across 2 groups is 8,000 naira.');
    expect(
      renderIntentAnswer({ intent: 'vsla.position', kind: 'no_membership' }, 'yo')
    ).toContain('V S L A');
  });
});

describe('renderIntentAnswer — voucher.status', () => {
  it('renders the latest voucher status per locale', () => {
    const answer = {
      intent: 'voucher.status',
      kind: 'ok',
      status: 'REDEEMED',
      amountKobo: 500000
    } as const;
    expect(renderIntentAnswer(answer, 'en')).toBe(
      'Your most recent input voucher for 5,000 naira is already redeemed.'
    );
    expect(renderIntentAnswer(answer, 'ha')).toContain('an riga an karbe ta');
  });

  it('renders every status without throwing', () => {
    for (const status of ['ISSUED', 'REDEEMING', 'REDEEMED', 'EXPIRING', 'EXPIRED', 'VOIDING', 'VOIDED'] as const) {
      for (const locale of ['en', 'ha', 'yo', 'ig'] as const) {
        const spoken = renderIntentAnswer(
          { intent: 'voucher.status', kind: 'ok', status, amountKobo: 100 },
          locale
        );
        expect(spoken.length).toBeGreaterThan(10);
      }
    }
  });

  it('renders the no-voucher answer', () => {
    expect(renderIntentAnswer({ intent: 'voucher.status', kind: 'no_voucher' }, 'en')).toBe(
      'You have no input vouchers on record.'
    );
  });
});

describe('fail-closed and auth templates', () => {
  it('unavailable is spoken per locale (never a stale value)', () => {
    expect(renderUnavailable('en')).toContain('unavailable');
    expect(renderUnavailable('ha')).toContain('ba ya samuwa');
    expect(renderUnavailable('yo')).toContain('ko wa lowolowo');
    expect(renderUnavailable('ig')).toContain('adighi ugbu a');
  });

  it('PIN templates render per locale', () => {
    expect(renderPinWrong('en')).toBe('That PIN is not correct.');
    expect(renderPinLocked('en')).toContain('fifteen minutes');
    expect(renderPinNotSet('en')).toContain('not set up a security PIN');
    expect(renderNotRegistered('en')).toContain('not registered');
  });
});
