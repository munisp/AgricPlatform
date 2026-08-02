/**
 * farmOS / LiteFarm farm-record sync clients (wave P5a, matrix Phase 3).
 * farmOS exposes a JSON:API (`/api/{type}/{bundle}`); LiteFarm exposes a
 * REST API per deployment. Both normalise remote documents into
 * NormalisedFarmRecord rows that the ACL adapter persists into
 * integrations.farm_records. Construction is fail closed: a non-stub
 * FARM_RECORDS_DRIVER without the full credential set raises
 * ProviderConfigError at boot instead of placing a live call with
 * placeholder configuration.
 */
import { httpJson, httpRequest, requireEnv } from './http.js';
import type { FarmRecordType } from '../../../database/repositories/phase3.repository.js';

/** ACL-normalised farm record ready for integrations.farm_records. */
export interface NormalisedFarmRecord {
  recordType: FarmRecordType;
  /** Record id on the remote system (replay dedupe key part). */
  externalId: string;
  /** Normalised payload kept for downstream consumers (credit signals). */
  payload: Record<string, unknown>;
  /** farmos | litefarm */
  source: string;
  /** ISO-8601 observation timestamp from the remote system. */
  observedAt: string;
}

export interface FarmRecordClient {
  readonly name: string;
  /** Pulls and normalises the farmer's records visible to the linked account. */
  fetchRecords(externalAccountId: string): Promise<NormalisedFarmRecord[]>;
  /** Pushes the platform's member verification status to the remote system. */
  pushMemberVerification(externalAccountId: string, verified: boolean): Promise<void>;
}

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * farmOS 2.x JSON:API client. Polls the standard bundles that carry farm
 * production records: crop plans (`plan--crop_plan` style `plan` type),
 * harvest logs (`log--harvest`) and field maps (`asset--land`). The parser
 * is tolerant by design (scaffold): resources without an id are skipped.
 */
export class FarmOsClient implements FarmRecordClient {
  readonly name = 'farmos';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, accept: 'application/vnd.api+json' };
  }

  private async listBundle(path: string): Promise<JsonApiResource[]> {
    const response = await httpJson<unknown>(this.name, this.url(path), {
      method: 'GET',
      headers: this.headers
    });
    const data = asRecord(response).data;
    return Array.isArray(data) ? (data as JsonApiResource[]) : [];
  }

  async fetchRecords(_externalAccountId: string): Promise<NormalisedFarmRecord[]> {
    const records: NormalisedFarmRecord[] = [];
    const bundles: Array<{ path: string; recordType: FarmRecordType }> = [
      { path: '/api/plan/plan', recordType: 'crop_plan' },
      { path: '/api/log/harvest', recordType: 'harvest' },
      { path: '/api/asset/land', recordType: 'field_map' }
    ];
    for (const bundle of bundles) {
      for (const resource of await this.listBundle(bundle.path)) {
        if (!resource.id) {
          continue;
        }
        const attributes = asRecord(resource.attributes);
        const observedAt =
          toIso(attributes['timestamp']) ??
          toIso(attributes['changed']) ??
          toIso(attributes['created']) ??
          new Date().toISOString();
        records.push({
          recordType: bundle.recordType,
          externalId: resource.id,
          payload: { type: resource.type, ...attributes },
          source: 'farmos',
          observedAt
        });
      }
    }
    return records;
  }

  /** Outbound member verification push (platform → farmOS webhook bridge). */
  async pushMemberVerification(externalAccountId: string, verified: boolean): Promise<void> {
    await httpRequest(this.name, this.url('/api/platform/member-verification'), {
      method: 'POST',
      headers: this.headers,
      body: {
        data: {
          type: 'platform--member_verification',
          attributes: { external_account_id: externalAccountId, verified }
        }
      }
    });
  }
}

interface LiteFarmRecord {
  id?: string | number;
  record_type?: string;
  type?: string;
  updated_at?: string;
  created_at?: string;
  [key: string]: unknown;
}

const LITEFARM_TYPE_MAP: Record<string, FarmRecordType> = {
  crop_plan: 'crop_plan',
  planting_management_plan: 'crop_plan',
  harvest: 'harvest',
  harvest_task: 'harvest',
  field: 'field_map',
  location: 'field_map'
};

/**
 * LiteFarm REST client (per-deployment API key). Accepts
 * `{ records: [...] }` or a bare array; rows whose type cannot be mapped to
 * a platform record type are skipped (tolerant scaffold).
 */
export class LiteFarmClient implements FarmRecordClient {
  readonly name = 'litefarm';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private get headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey };
  }

  async fetchRecords(_externalAccountId: string): Promise<NormalisedFarmRecord[]> {
    const response = await httpJson<unknown>(this.name, this.url('/api/records'), {
      method: 'GET',
      headers: this.headers
    });
    const rows = Array.isArray(response)
      ? (response as LiteFarmRecord[])
      : ((asRecord(response).records as LiteFarmRecord[] | undefined) ?? []);
    const records: NormalisedFarmRecord[] = [];
    for (const row of rows) {
      const recordType = LITEFARM_TYPE_MAP[String(row.record_type ?? row.type ?? '')];
      const id = row.id;
      if (!recordType || id === undefined) {
        continue;
      }
      records.push({
        recordType,
        externalId: String(id),
        payload: { ...row },
        source: 'litefarm',
        observedAt: toIso(row.updated_at) ?? toIso(row.created_at) ?? new Date().toISOString()
      });
    }
    return records;
  }

  async pushMemberVerification(externalAccountId: string, verified: boolean): Promise<void> {
    await httpRequest(this.name, this.url('/api/integrations/member-verification'), {
      method: 'POST',
      headers: this.headers,
      body: { external_account_id: externalAccountId, verified }
    });
  }
}

/** True when at least one farm-record client may be constructed. */
export function farmRecordsDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.FARM_RECORDS_DRIVER;
  const live = flag === 'live' || flag === 'production' || flag === 'sandbox';
  return live && Boolean(env.FARMOS_BASE_URL || env.LITEFARM_BASE_URL);
}

/**
 * Builds the configured farm-record clients. Fail closed: with a non-stub
 * driver flag every configured system's full credential set is required —
 * a partial configuration raises ProviderConfigError at boot.
 */
export function createFarmRecordClients(env: NodeJS.ProcessEnv = process.env): FarmRecordClient[] {
  const flag = env.FARM_RECORDS_DRIVER ?? 'stub';
  if (flag === 'stub') {
    return [];
  }
  const clients: FarmRecordClient[] = [];
  if (env.FARMOS_BASE_URL) {
    clients.push(new FarmOsClient(env.FARMOS_BASE_URL, requireEnv('farmos', env, ['FARMOS_API_KEY'])));
  }
  if (env.LITEFARM_BASE_URL) {
    clients.push(
      new LiteFarmClient(env.LITEFARM_BASE_URL, requireEnv('litefarm', env, ['LITEFARM_API_KEY']))
    );
  }
  return clients;
}
