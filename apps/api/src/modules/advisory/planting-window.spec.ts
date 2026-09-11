import { describe, expect, it } from 'vitest';
import {
  addDays,
  computePlantingWindow,
  CROP_RULES,
  daysBetween,
  findCropRule,
  PLANTING_RULES_VERSION,
  renderPulseMessage,
  shortDate,
  type DailyRainPoint
} from './planting-window.js';

/** Builds a 14-day series from 2026-06-01 with the given daily rain. */
function series(rain: number[], startDate = '2026-06-01'): DailyRainPoint[] {
  return rain.map((precipitationMm, index) => ({
    date: addDays(startDate, index),
    precipitationMm
  }));
}

describe('crop rule table', () => {
  it('is versioned and covers the core Nigerian smallholder crops', () => {
    expect(PLANTING_RULES_VERSION).toBe('planting-rules-v1');
    const crops = CROP_RULES.map((rule) => rule.crop);
    for (const expected of ['maize', 'rice', 'sorghum', 'millet', 'cowpea', 'cassava', 'yam']) {
      expect(crops).toContain(expected);
    }
  });

  it('every rule has a sane threshold, window and season', () => {
    for (const rule of CROP_RULES) {
      expect(rule.onsetRainMm).toBeGreaterThan(0);
      expect(rule.windowDays).toBeGreaterThanOrEqual(7);
      expect(rule.seasonStartMonth).toBeGreaterThanOrEqual(1);
      expect(rule.seasonEndMonth).toBeLessThanOrEqual(12);
      expect(rule.seasonEndMonth).toBeGreaterThanOrEqual(rule.seasonStartMonth);
    }
  });

  it('resolves aliases case-insensitively', () => {
    expect(findCropRule(' Maize ')?.crop).toBe('maize');
    expect(findCropRule('dawa')?.crop).toBe('sorghum');
    expect(findCropRule('quinoa')).toBeUndefined();
  });
});

describe('date helpers', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-06-28', 5)).toBe('2026-07-03');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('daysBetween is exact for whole-day differences', () => {
    expect(daysBetween('2026-06-01', '2026-06-11')).toBe(10);
    expect(daysBetween('2026-06-11', '2026-06-01')).toBe(-10);
  });

  it('shortDate renders deterministically', () => {
    expect(shortDate('2026-06-12')).toBe('12 Jun');
    expect(shortDate('2026-01-05')).toBe('5 Jan');
  });
});

describe('computePlantingWindow — known-answer vectors', () => {
  it('maize: onset on the first day whose 3-day rain reaches 20mm', () => {
    // Days 1-3: 4+6+8 = 18mm (< 20) — no onset. Days 2-4: 6+8+9 = 23mm — onset at day 2.
    const result = computePlantingWindow({
      crop: 'maize',
      daily: series([4, 6, 8, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      referenceDate: '2026-06-01'
    });
    expect(result).toEqual({
      kind: 'window',
      crop: 'maize',
      windowStart: '2026-06-02',
      windowEnd: '2026-06-16',
      onsetDate: '2026-06-02',
      onsetRainMm: 23,
      daysUntilOnset: 1,
      confidence: 'medium',
      ruleVersion: 'planting-rules-v1'
    });
  });

  it('high confidence when the 3-day rain is ≥1.5× the threshold', () => {
    const result = computePlantingWindow({
      crop: 'maize',
      daily: series([15, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      referenceDate: '2026-06-01'
    });
    expect(result).toMatchObject({ kind: 'window', onsetRainMm: 30, confidence: 'high' });
  });

  it('sorghum: lower 15mm threshold triggers where maize would wait', () => {
    const daily = series([5, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(computePlantingWindow({ crop: 'maize', daily, referenceDate: '2026-06-01' })).toEqual({
      kind: 'wait',
      crop: 'maize',
      reason: 'no_onset_in_horizon',
      onsetRainMm: 0,
      ruleVersion: 'planting-rules-v1'
    });
    expect(
      computePlantingWindow({ crop: 'sorghum', daily, referenceDate: '2026-06-01' })
    ).toMatchObject({ kind: 'window', windowStart: '2026-06-01', windowEnd: '2026-06-22' });
  });

  it('an onset outside the crop season is NOT a window (fail-closed)', () => {
    // Maize season ends in July; a September onset must not advise planting.
    const result = computePlantingWindow({
      crop: 'maize',
      daily: series([10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], '2026-09-01'),
      referenceDate: '2026-09-01'
    });
    expect(result).toEqual({
      kind: 'wait',
      crop: 'maize',
      reason: 'outside_season',
      onsetRainMm: 30,
      ruleVersion: 'planting-rules-v1'
    });
  });

  it('dry 14-day horizon → wait, never a window', () => {
    const result = computePlantingWindow({
      crop: 'rice',
      daily: series(new Array(14).fill(0)),
      referenceDate: '2026-06-01'
    });
    expect(result).toMatchObject({ kind: 'wait', reason: 'no_onset_in_horizon' });
  });

  it('null-equivalent dry tails never extend an onset window', () => {
    // Onset at the last possible start index (day 11 of 14).
    const rain = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 7, 6];
    const result = computePlantingWindow({
      crop: 'cowpea', // threshold 15, season Jun–Aug
      daily: series(rain),
      referenceDate: '2026-06-01'
    });
    expect(result).toMatchObject({
      kind: 'window',
      onsetDate: '2026-06-11',
      daysUntilOnset: 10,
      windowEnd: '2026-06-25'
    });
  });

  it('unknown crops fail closed', () => {
    expect(
      computePlantingWindow({ crop: 'quinoa', daily: series([30, 0, 0]), referenceDate: '2026-06-01' })
    ).toEqual({ kind: 'unknown_crop', crop: 'quinoa' });
  });

  it('is deterministic: identical inputs produce byte-identical results', () => {
    const input = {
      crop: 'maize',
      daily: series([4, 6, 8, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      referenceDate: '2026-06-01'
    };
    expect(computePlantingWindow(input)).toEqual(computePlantingWindow(input));
  });
});

describe('renderPulseMessage', () => {
  const window = {
    kind: 'window' as const,
    crop: 'maize',
    windowStart: '2026-06-02',
    windowEnd: '2026-06-16',
    onsetDate: '2026-06-02',
    onsetRainMm: 23,
    daysUntilOnset: 1,
    confidence: 'medium' as const,
    ruleVersion: PLANTING_RULES_VERSION
  };
  const wait = {
    kind: 'wait' as const,
    crop: 'maize',
    reason: 'no_onset_in_horizon' as const,
    onsetRainMm: 0,
    ruleVersion: PLANTING_RULES_VERSION
  };

  it('renders the English window template with all slots filled', () => {
    const message = renderPulseMessage(window, {
      plotName: 'North field',
      locale: 'en',
      forecastDate: '2026-06-01'
    });
    expect(message).toBe(
      'AgricPlatform: Plant maize on plot North field between 2 Jun and 16 Jun. ' +
        'Rain onset expected 2 Jun (23mm over 3 days). Forecast: Open-Meteo 2026-06-01.'
    );
  });

  it('renders Hausa and Yoruba drafts (3-language rendering)', () => {
    const ha = renderPulseMessage(window, { plotName: 'North field', locale: 'ha', forecastDate: '2026-06-01' });
    const yo = renderPulseMessage(window, { plotName: 'North field', locale: 'yo', forecastDate: '2026-06-01' });
    expect(ha).toContain('maize');
    expect(ha).toContain('Open-Meteo');
    expect(ha).not.toContain('{crop}');
    expect(yo).toContain('maize');
    expect(yo).not.toContain('{plot}');
  });

  it('renders the wait message honestly (no invented dates)', () => {
    const message = renderPulseMessage(wait, {
      plotName: 'North field',
      locale: 'en',
      forecastDate: '2026-06-01'
    });
    expect(message).toContain('No reliable planting window');
    expect(message).not.toContain('between');
  });

  it('falls back to English for unknown locales', () => {
    const message = renderPulseMessage(window, {
      plotName: 'North field',
      locale: 'ig',
      forecastDate: '2026-06-01'
    });
    expect(message).toContain('Plant maize');
  });
});
