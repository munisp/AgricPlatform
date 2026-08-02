import { describe, expect, it } from 'vitest';
import {
  analyticsExportCsv,
  analyticsExportPdf,
  csvField,
  toCsv,
  type AnalyticsExportBundle
} from './export-formats.js';

const bundle: AnalyticsExportBundle = {
  generatedAt: '2026-08-02T09:00:00.000Z',
  metrics: [
    { key: 'farmers_onboarded', label: 'Farmers onboarded', value: 4200, unit: 'farmers', trend: 12 },
    { key: 'quotes,with,commas', label: 'Tricky "quoted" label', value: 3 }
  ],
  overview: { users: 9000, courses: 12 },
  byRole: [{ key: 'farmer', count: 8000 }],
  byState: [{ key: 'Kaduna', count: 1200 }]
};

describe('toCsv (RFC 4180)', () => {
  it('joins rows with CRLF and terminates the final record', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n');
  });

  it('quotes fields containing commas, quotes, CR or LF and escapes quotes as ""', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('has,comma')).toBe('"has,comma"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('renders null/undefined as empty fields and numbers verbatim', () => {
    expect(toCsv([[1, null, undefined, 'x']])).toBe('1,,,x\r\n');
  });
});

describe('analyticsExportCsv', () => {
  it('renders every section with a header row', () => {
    const csv = analyticsExportCsv(bundle);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('agric-platform analytics export');
    expect(csv).toContain('section,key,label,value,unit,trend');
    expect(csv).toContain('metric,farmers_onboarded,Farmers onboarded,4200,farmers,12');
    expect(csv).toContain('overview,users,,9000,,');
    expect(csv).toContain('segment_role,farmer,,8000,,');
    expect(csv).toContain('segment_state,Kaduna,,1200,,');
    // commas and quotes inside values are RFC 4180 escaped
    expect(csv).toContain('metric,"quotes,with,commas","Tricky ""quoted"" label",3,,');
  });
});

describe('analyticsExportPdf', () => {
  it('renders a non-empty PDF document', async () => {
    const pdf = await analyticsExportPdf(bundle);
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
