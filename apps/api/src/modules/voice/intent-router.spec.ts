import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_MENU_DTMF,
  formatIntegerSpeech,
  intentForDtmf,
  intentForTranscript,
  normalizeTranscript,
  normalizeVoiceIntentLocale,
  speakDate,
  speakMoneyKobo,
  VOICE_INTENT_IDS
} from './intent-router.js';

/**
 * Voice Teller grammar known-answer tests (Stage 27, Innovation 6): every
 * DTMF key and every ASR-slot fixture resolves to exactly one intent (or
 * none). The router is deterministic — same input, same intent, always.
 */

describe('intentForDtmf (account-menu grammar)', () => {
  it('maps the five menu digits to the four-plus-float intent catalog', () => {
    expect(intentForDtmf('1')).toBe('balance.savings');
    expect(intentForDtmf('2')).toBe('balance.float');
    expect(intentForDtmf('3')).toBe('loan.next_installment');
    expect(intentForDtmf('4')).toBe('vsla.position');
    expect(intentForDtmf('5')).toBe('voucher.status');
    // The spoken menu and the mapping share one source — never drift.
    expect(Object.keys(ACCOUNT_MENU_DTMF).sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(new Set(Object.values(ACCOUNT_MENU_DTMF))).toEqual(new Set(VOICE_INTENT_IDS));
  });

  it('rejects non-menu digits and empty input', () => {
    expect(intentForDtmf('6')).toBeUndefined();
    expect(intentForDtmf('0')).toBeUndefined();
    expect(intentForDtmf('9')).toBeUndefined();
    expect(intentForDtmf('')).toBeUndefined();
    expect(intentForDtmf('11')).toBeUndefined();
  });
});

describe('intentForTranscript (ASR-slot grammar, known-answer fixtures)', () => {
  const fixtures: Array<[string, string | undefined, string?]> = [
    // English
    ['What is my savings balance please', 'balance.savings'],
    ['how much do I have in my account', 'balance.savings'],
    ['check my balance', 'balance.savings'],
    ['my float balance', 'balance.float'],
    ['how much float do I have left', 'balance.float'],
    ['when is my next installment due', 'loan.next_installment'],
    ['how much is my next repayment', 'loan.next_installment'],
    ['what is my VSLA position', 'vsla.position'],
    ['when is the share out happening', 'vsla.position'],
    ['has my voucher been redeemed', 'voucher.status'],
    ['voucher status please', 'voucher.status'],
    // Longest-phrase precedence: 'float balance' (13) beats 'balance' (7).
    ['float balance', 'balance.float'],
    // 'repayment' (9) beats 'balance' (7) when both appear.
    ['what balance do I still owe on my repayment', 'loan.next_installment'],
    // Hausa slots
    ['ina son balan ajiyata', 'balance.savings', 'ha'],
    ['yaya biyan bashi na', 'loan.next_installment', 'ha'],
    ['mene ne matsayina a kungiya', 'vsla.position', 'ha'],
    ['baucar tallafi na', 'voucher.status', 'ha'],
    // Yoruba slots
    ['owo ifowopamo mi', 'balance.savings', 'yo'],
    ['bese mi nla', 'loan.next_installment', 'yo'],
    ['ipo ajo mi', 'vsla.position', 'yo'],
    // Igbo slots
    ['ego echekwara m', 'balance.savings', 'ig'],
    ['ugwo mgbinye m', 'loan.next_installment', 'ig'],
    ['isusu m', 'vsla.position', 'ig'],
    // Code-switching: English grammar always applies on top of the locale.
    ['bin voucher status na', 'voucher.status', 'ha'],
    // Outside the four intents → undefined (caller routes to RAG/escalation).
    ['tell me about maize planting season', undefined],
    ['how do I treat fall armyworm', undefined],
    ['', undefined],
    ['   ', undefined]
  ];

  it.each(fixtures)('%j → %s (locale %s)', (transcript, expected, locale) => {
    expect(intentForTranscript(transcript, locale)).toBe(expected);
  });

  it('unknown locales fall back to the English grammar', () => {
    expect(intentForTranscript('my savings balance', 'fr')).toBe('balance.savings');
    expect(intentForTranscript('ajiya', 'fr')).toBeUndefined();
  });

  it('is punctuation- and case-insensitive', () => {
    expect(normalizeTranscript('  My FLOAT, Balance!! ')).toBe('my float balance');
    expect(intentForTranscript('MY FLOAT BALANCE!!')).toBe('balance.float');
  });
});

describe('locale normalisation', () => {
  it('keeps supported locales and falls back to en', () => {
    expect(normalizeVoiceIntentLocale('ha')).toBe('ha');
    expect(normalizeVoiceIntentLocale('YO')).toBe('yo');
    expect(normalizeVoiceIntentLocale(undefined)).toBe('en');
    expect(normalizeVoiceIntentLocale('pcm')).toBe('en'); // Pidgin: content dependency
  });
});

describe('formatIntegerSpeech (deterministic, ICU-free grouping)', () => {
  it('groups thousands with commas', () => {
    expect(formatIntegerSpeech(0)).toBe('0');
    expect(formatIntegerSpeech(7)).toBe('7');
    expect(formatIntegerSpeech(42)).toBe('42');
    expect(formatIntegerSpeech(999)).toBe('999');
    expect(formatIntegerSpeech(1000)).toBe('1,000');
    expect(formatIntegerSpeech(1234567)).toBe('1,234,567');
    expect(formatIntegerSpeech(900000000000)).toBe('900,000,000,000');
  });

  it('rejects negatives and non-integers', () => {
    expect(() => formatIntegerSpeech(-1)).toThrow(RangeError);
    expect(() => formatIntegerSpeech(1.5)).toThrow(RangeError);
  });
});

describe('speakMoneyKobo (kobo → naira speech, per locale)', () => {
  it('renders naira and kobo clauses', () => {
    expect(speakMoneyKobo(123456, 'en')).toBe('1,234 naira and 56 kobo');
    expect(speakMoneyKobo(100000, 'en')).toBe('1,000 naira');
    expect(speakMoneyKobo(75, 'en')).toBe('75 kobo');
    expect(speakMoneyKobo(0, 'en')).toBe('0 kobo');
    expect(speakMoneyKobo(100, 'en')).toBe('1 naira');
  });

  it('uses locale glue words', () => {
    expect(speakMoneyKobo(123456, 'ha')).toBe('1,234 naira da 56 kobo');
    expect(speakMoneyKobo(123456, 'yo')).toBe('1,234 naira ati 56 kobo');
    expect(speakMoneyKobo(123456, 'ig')).toBe('1,234 naira na 56 kobo');
  });

  it('rejects non-integer/negative amounts — never rounds money', () => {
    expect(() => speakMoneyKobo(-100, 'en')).toThrow(RangeError);
    expect(() => speakMoneyKobo(99.9, 'en')).toThrow(RangeError);
  });
});

describe('speakDate (per-locale month names)', () => {
  it('renders the UTC calendar date', () => {
    expect(speakDate('2026-10-05T14:30:00.000Z', 'en')).toBe('5 October 2026');
    expect(speakDate('2026-01-01T00:00:00.000Z', 'ha')).toBe('1 Janairu 2026');
    expect(speakDate('2026-03-11T00:00:00.000Z', 'yo')).toBe('11 Masi 2026');
    expect(speakDate('2026-03-11T00:00:00.000Z', 'ig')).toBe('11 Maachi 2026');
  });

  it('throws on malformed dates — a bad due date is never spoken', () => {
    expect(() => speakDate('not-a-date', 'en')).toThrow(RangeError);
  });
});
