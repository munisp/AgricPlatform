/**
 * Minimal type declarations for parquetjs-lite (CJS, no bundled types).
 * Only the surface used by the lakehouse exporter is declared: schema
 * definition, buffered writing via openStream and readback via
 * ParquetReader.openBuffer (used by tests).
 */
declare module 'parquetjs-lite' {
  import type { Writable } from 'node:stream';

  export interface ParquetFieldDef {
    type: string;
    optional?: boolean;
    repeated?: boolean;
    compression?: string;
  }

  export class ParquetSchema {
    constructor(schema: Record<string, ParquetFieldDef>);
  }

  export class ParquetWriter {
    static openStream(schema: ParquetSchema, outputStream: Writable): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }

  export interface ParquetCursor {
    next(): Promise<Record<string, unknown> | null>;
  }

  export class ParquetReader {
    static openBuffer(buffer: Buffer): Promise<ParquetReader>;
    getCursor(): ParquetCursor;
    close(): Promise<void>;
  }
}
