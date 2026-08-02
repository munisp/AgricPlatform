/**
 * NAERLS / FMARD e-Extension advisory feeds (wave P5a, matrix Phase 3).
 * Read-only scheduled pull mapping external pest alerts and agronomy
 * bulletins into platform AdvisoryItems tagged with source + region. The
 * scheduler stays inert unless EXTENSION_FEED_DRIVER is live (or
 * sandbox/production) AND at least one feed credential is present —
 * mirroring the market-data ingestion pattern.
 */
import { httpJson, requireEnv } from './http.js';

/** Normalised bulletin ready for mapping onto an AdvisoryItem. */
export interface ExtensionBulletin {
  /** Bulletin id on the source system (drives deterministic item ids). */
  externalId: string;
  kind: 'pest_alert' | 'guide';
  title: string;
  summary: string;
  /** Region/state the bulletin applies to (advisory tagging). */
  state?: string;
  crop?: string;
  severity?: 'info' | 'warning' | 'critical';
  publishedAt: string;
  source: string;
}

export interface ExtensionFeedSource {
  readonly name: string;
  fetchLatest(): Promise<ExtensionBulletin[]>;
}

interface RawBulletin {
  id?: string | number;
  type?: string;
  kind?: string;
  title?: string;
  summary?: string;
  body?: string;
  state?: string;
  region?: string;
  crop?: string;
  severity?: string;
  published_at?: string;
  date?: string;
}

const SEVERITIES = new Set(['info', 'warning', 'critical']);

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalise(rows: RawBulletin[], source: string): ExtensionBulletin[] {
  const bulletins: ExtensionBulletin[] = [];
  for (const row of rows) {
    const publishedAt = toIso(row.published_at ?? row.date);
    if (row.id === undefined || !row.title || !publishedAt) {
      continue;
    }
    const kind = (row.kind ?? row.type) === 'pest_alert' ? 'pest_alert' : 'guide';
    const severity = SEVERITIES.has(String(row.severity))
      ? (row.severity as ExtensionBulletin['severity'])
      : undefined;
    bulletins.push({
      externalId: String(row.id),
      kind,
      title: row.title,
      summary: row.summary ?? row.body ?? '',
      state: row.state ?? row.region,
      crop: row.crop,
      severity,
      publishedAt,
      source
    });
  }
  return bulletins;
}

function envelope(response: unknown): RawBulletin[] {
  if (Array.isArray(response)) {
    return response as RawBulletin[];
  }
  const record = response as Record<string, unknown>;
  const rows = record?.['bulletins'] ?? record?.['data'];
  return Array.isArray(rows) ? (rows as RawBulletin[]) : [];
}

/** NAERLS e-Extension bulletin feed (`x-api-key` auth). */
export class NaerlsExtensionSource implements ExtensionFeedSource {
  readonly name = 'naerls';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async fetchLatest(): Promise<ExtensionBulletin[]> {
    const response = await httpJson<unknown>(
      this.name,
      `${this.baseUrl.replace(/\/$/, '')}/v1/advisories`,
      { method: 'GET', headers: { 'x-api-key': this.apiKey } }
    );
    return normalise(envelope(response), 'NAERLS');
  }
}

/** FMARD e-Extension bulletin feed (bearer auth). */
export class FmardExtensionSource implements ExtensionFeedSource {
  readonly name = 'fmard';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async fetchLatest(): Promise<ExtensionBulletin[]> {
    const response = await httpJson<unknown>(
      this.name,
      `${this.baseUrl.replace(/\/$/, '')}/api/extension/bulletins`,
      { method: 'GET', headers: { authorization: `Bearer ${this.apiKey}` } }
    );
    return normalise(envelope(response), 'FMARD');
  }
}

/** True when the e-Extension pull is allowed to run. */
export function extensionFeedDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.EXTENSION_FEED_DRIVER;
  return (
    (flag === 'live' || flag === 'production' || flag === 'sandbox') &&
    Boolean((env.NAERLS_BASE_URL && env.NAERLS_API_KEY) || (env.FMARD_BASE_URL && env.FMARD_API_KEY))
  );
}

/** Fail-closed factory; returns no sources while the driver is stub. */
export function createExtensionFeedSources(env: NodeJS.ProcessEnv = process.env): ExtensionFeedSource[] {
  const flag = env.EXTENSION_FEED_DRIVER ?? 'stub';
  if (flag === 'stub') {
    return [];
  }
  const sources: ExtensionFeedSource[] = [];
  if (env.NAERLS_BASE_URL) {
    sources.push(new NaerlsExtensionSource(env.NAERLS_BASE_URL, requireEnv('naerls', env, ['NAERLS_API_KEY'])));
  }
  if (env.FMARD_BASE_URL) {
    sources.push(new FmardExtensionSource(env.FMARD_BASE_URL, requireEnv('fmard', env, ['FMARD_API_KEY'])));
  }
  return sources;
}
