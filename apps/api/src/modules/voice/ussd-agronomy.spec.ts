import { describe, expect, it } from 'vitest';
import {
  agronomyQueryFor,
  handleAgronomyUssdTurn,
  initialAgronomyUssdState,
  USSD_SYMPTOM_CATEGORIES
} from './ussd-agronomy.js';

describe('USSD agronomy menu engine', () => {
  it('opens with the crop menu on an empty first input', () => {
    const turn = handleAgronomyUssdTurn(initialAgronomyUssdState(), '');
    expect(turn.response.startsWith('CON')).toBe(true);
    expect(turn.response).toContain('Maize');
    expect(turn.end).toBe(false);
    expect(turn.state.menu).toBe('crop');
  });

  it('crop → symptom → agronomy_query effect', () => {
    const crop = handleAgronomyUssdTurn(initialAgronomyUssdState(), '1');
    expect(crop.state.menu).toBe('symptom');
    expect(crop.state.crop).toBe('Maize');
    expect(crop.response).toContain('what is the problem');

    const symptom = handleAgronomyUssdTurn(crop.state, '1');
    expect(symptom.end).toBe(true);
    expect(symptom.effect).toEqual({
      type: 'agronomy_query',
      crop: 'Maize',
      category: 'pests',
      categoryLabel: 'Pests and insects'
    });
    expect(agronomyQueryFor('Maize', 'Pests and insects')).toBe('Maize Pests and insects');
  });

  it('9 asks for a human agent from any menu', () => {
    const turn = handleAgronomyUssdTurn({ menu: 'symptom', crop: 'Rice' }, '9');
    expect(turn.end).toBe(true);
    expect(turn.effect?.type).toBe('escalate');
    expect(turn.response).toContain('agronomist');
  });

  it('0 restarts from a sub-menu back to the crop menu', () => {
    const turn = handleAgronomyUssdTurn({ menu: 'symptom', crop: 'Rice' }, '0');
    expect(turn.state.menu).toBe('crop');
    expect(turn.response).toContain('select crop');
  });

  it('rejects invalid choices without leaving the menu', () => {
    const state = initialAgronomyUssdState();
    const bad = handleAgronomyUssdTurn(state, '42');
    expect(bad.state.menu).toBe('crop');
    expect(bad.response).toContain('Invalid choice');
    const badSymptom = handleAgronomyUssdTurn({ menu: 'symptom', crop: 'Yam' }, 'x');
    expect(badSymptom.state.menu).toBe('symptom');
    expect(badSymptom.response).toContain('Invalid choice');
  });

  it('every menu screen fits one feature-phone turnaround (≤182 chars)', () => {
    const screens = [
      handleAgronomyUssdTurn(initialAgronomyUssdState(), ''),
      handleAgronomyUssdTurn(initialAgronomyUssdState(), '2'),
      handleAgronomyUssdTurn(initialAgronomyUssdState(), '99')
    ];
    for (const screen of screens) {
      expect(screen.response.length).toBeLessThanOrEqual(182);
    }
    expect(USSD_SYMPTOM_CATEGORIES.length).toBeGreaterThanOrEqual(5);
  });
});
