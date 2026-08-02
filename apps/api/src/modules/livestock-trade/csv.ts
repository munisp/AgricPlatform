/**
 * Minimal RFC 4180 CSV string builder for the compliance export (F6).
 * Mirrors the analytics export-formats conventions (CRLF record
 * separators, `"` escaped as `""`, fields containing [",\r\n] quoted) with
 * no external CSV library. Streaming-friendly: rows are appended to a
 * plain string buffer, so large sections never materialise intermediate
 * structures beyond the output itself.
 */

export type CsvValue = string | number | boolean | null | undefined;

export function csvField(value: CsvValue): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class CsvBuilder {
  private buffer = '';

  row(values: ReadonlyArray<CsvValue>): this {
    this.buffer += values.map(csvField).join(',') + '\r\n';
    return this;
  }

  toString(): string {
    return this.buffer;
  }
}
