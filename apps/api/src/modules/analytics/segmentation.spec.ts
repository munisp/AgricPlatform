import { describe, expect, it } from 'vitest';
import { percentage, segmentCounts } from './segmentation.js';

describe('percentage', () => {
  it('rounds to 2 decimals', () => {
    expect(percentage(1, 3)).toBe(33.33);
    expect(percentage(2, 3)).toBe(66.67);
  });

  it('is 0 for an empty population (no divide-by-zero)', () => {
    expect(percentage(5, 0)).toBe(0);
  });
});

describe('segmentCounts', () => {
  it('counts single-valued dimensions with percentages of the population', () => {
    const result = segmentCounts(
      [{ state: 'Kano' }, { state: 'Kano' }, { state: 'Lagos' }],
      (item) => [item.state],
      'state'
    );
    expect(result.total).toBe(3);
    expect(result.segments).toEqual([
      { key: 'Kano', count: 2, percentage: 66.67 },
      { key: 'Lagos', count: 1, percentage: 33.33 }
    ]);
  });

  it('multi-valued dimensions place one member in several segments', () => {
    const result = segmentCounts(
      [{ crops: ['maize', 'rice'] }, { crops: ['maize'] }],
      (item) => item.crops,
      'crop'
    );
    expect(result.segments).toEqual([
      { key: 'maize', count: 2, percentage: 100 },
      { key: 'rice', count: 1, percentage: 50 }
    ]);
  });

  it('skips empty keys (members without the attribute) but keeps them in the total', () => {
    const result = segmentCounts([{ state: '' }, { state: 'Kano' }], (item) => [item.state], 'state');
    expect(result.total).toBe(2);
    expect(result.segments).toEqual([{ key: 'Kano', count: 1, percentage: 50 }]);
  });

  it('deduplicates repeated keys within one item', () => {
    const result = segmentCounts([{ roles: ['farmer', 'farmer'] }], (item) => item.roles, 'role');
    expect(result.segments).toEqual([{ key: 'farmer', count: 1, percentage: 100 }]);
  });

  it('sorts by count descending then key ascending', () => {
    const result = segmentCounts(
      [{ k: 'b' }, { k: 'a' }, { k: 'b' }, { k: 'c' }],
      (item) => [item.k],
      'cohort'
    );
    expect(result.segments.map((s) => s.key)).toEqual(['b', 'a', 'c']);
  });
});
