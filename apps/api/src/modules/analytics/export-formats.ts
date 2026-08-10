import PDFDocument from 'pdfkit';

/**
 * Analytics export renderers (Wave P3).
 *
 * - `toCsv`: RFC 4180 formatter (CRLF record separators, `"` escaped as `""`,
 *   fields containing [",\r\n] are quoted). Pure string transform, unit tested.
 * - `analyticsExportCsv`: flattens the JSON export bundle into a sectioned CSV.
 * - `analyticsExportPdf`: simple tabular PDF via pdfkit (no external services).
 */

export type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = ReadonlyArray<CsvValue>;

/** RFC 4180 field encoding. */
export function csvField(value: CsvValue): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 document: rows joined by CRLF with a trailing CRLF. */
export function toCsv(rows: ReadonlyArray<CsvRow>): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Shape of the analytics export bundle produced by AnalyticsService.export(). */
export interface AnalyticsExportBundle {
  generatedAt: string;
  metrics: ReadonlyArray<{
    key: string;
    label: string;
    value: number;
    unit?: string;
    trend?: number;
    /** Honesty flag: 'live' = repository-computed; 'seed' = labelled fixture. */
    basis: 'seed' | 'live';
  }>;
  overview: Record<string, number>;
  byRole: ReadonlyArray<{ key: string; count: number }>;
  byState: ReadonlyArray<{ key: string; count: number }>;
}

/** Sectioned CSV rendering of the export bundle. */
export function analyticsExportCsv(bundle: AnalyticsExportBundle): string {
  const rows: CsvRow[] = [
    ['agric-platform analytics export'],
    ['generated_at', bundle.generatedAt],
    [],
    ['section', 'key', 'label', 'value', 'unit', 'trend'],
    ...bundle.metrics.map(
      (metric): CsvRow => ['metric', metric.key, metric.label, metric.value, metric.unit, metric.trend]
    ),
    ...Object.entries(bundle.overview).map(
      ([key, value]): CsvRow => ['overview', key, '', value, '', '']
    ),
    ...bundle.byRole.map((segment): CsvRow => ['segment_role', segment.key, '', segment.count, '', '']),
    ...bundle.byState.map((segment): CsvRow => ['segment_state', segment.key, '', segment.count, '', ''])
  ];
  return toCsv(rows);
}

/**
 * Simple tabular PDF rendering of the export bundle. Streams into an in-memory
 * buffer (exports are bounded: metrics + overview + one row per role/state).
 */
export function analyticsExportPdf(bundle: AnalyticsExportBundle): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('AgricPlatform analytics export');
    doc.fontSize(9).fillColor('gray').text(`Generated at ${bundle.generatedAt}`);
    doc.moveDown();

    const table = (title: string, header: string[], rows: string[][]) => {
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('black').text(title);
      doc.moveDown(0.25);
      const allRows = [header, ...rows];
      allRows.forEach((row, index) => {
        doc
          .fontSize(9)
          .fillColor(index === 0 ? 'gray' : 'black')
          .text(row.map((cell) => cell.slice(0, 60)).join('  |  '));
      });
    };

    table(
      'Platform metrics',
      ['key', 'label', 'value', 'unit', 'trend'],
      bundle.metrics.map((metric) => [
        metric.key,
        metric.label,
        String(metric.value),
        metric.unit ?? '',
        metric.trend === undefined ? '' : String(metric.trend)
      ])
    );
    table(
      'Overview',
      ['key', 'value'],
      Object.entries(bundle.overview).map(([key, value]) => [key, String(value)])
    );
    table(
      'Members by role',
      ['role', 'count'],
      bundle.byRole.map((segment) => [segment.key, String(segment.count)])
    );
    table(
      'Members by state',
      ['state', 'count'],
      bundle.byState.map((segment) => [segment.key, String(segment.count)])
    );

    doc.end();
  });
}
