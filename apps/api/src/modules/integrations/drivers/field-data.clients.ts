/**
 * ODK Central / KoboToolbox beneficiary pull clients (wave P5a, matrix
 * Phase 3). Both fetch raw submission rows that the beneficiary-import
 * service validates, hashes and stages for admin confirmation. The SFTP
 * pull is a fail-closed scaffold: constructing it with FIELD_DATA_DRIVER
 * live raises ProviderConfigError until the SFTP transport dependency is
 * approved (no silent live calls).
 */
import { httpJson, requireEnv, ProviderConfigError } from './http.js';

/** Raw beneficiary submission as returned by the field-data system. */
export interface BeneficiarySubmission {
  [key: string]: unknown;
}

export interface FieldDataSource {
  readonly name: string;
  fetchSubmissions(): Promise<BeneficiarySubmission[]>;
}

function asRows(response: unknown, envelopeKey: string): BeneficiarySubmission[] {
  if (Array.isArray(response)) {
    return response as BeneficiarySubmission[];
  }
  const envelope = (response as Record<string, unknown>)?.[envelopeKey];
  return Array.isArray(envelope) ? (envelope as BeneficiarySubmission[]) : [];
}

/**
 * KoboToolbox API v2 (`Authorization: Token …`); submissions come from the
 * asset data endpoint as `{ results: [...] }`.
 */
export class KoboToolboxClient implements FieldDataSource {
  readonly name = 'kobo';

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly assetUid: string
  ) {}

  async fetchSubmissions(): Promise<BeneficiarySubmission[]> {
    const response = await httpJson<unknown>(
      this.name,
      `${this.baseUrl.replace(/\/$/, '')}/api/v2/assets/${this.assetUid}/data.json`,
      { method: 'GET', headers: { authorization: `Token ${this.apiToken}` } }
    );
    return asRows(response, 'results');
  }
}

/**
 * ODK Central (`Authorization: Bearer …`); submissions list as
 * `{ value: [...] }` (OData-style envelope).
 */
export class OdkCentralClient implements FieldDataSource {
  readonly name = 'odk';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly projectId: string,
    private readonly formId: string
  ) {}

  async fetchSubmissions(): Promise<BeneficiarySubmission[]> {
    const response = await httpJson<unknown>(
      this.name,
      `${this.baseUrl.replace(/\/$/, '')}/v1/projects/${this.projectId}/forms/${this.formId}/submissions`,
      { method: 'GET', headers: { authorization: `Bearer ${this.token}` } }
    );
    return asRows(response, 'value');
  }
}

/**
 * SFTP-pull scaffold (partner MIS drop folders). The platform intentionally
 * ships no SFTP transport dependency yet; a live configuration fails closed
 * at boot until the transport is approved and wired (docs/integration-matrix).
 */
export class SftpFieldDataScaffold implements FieldDataSource {
  readonly name = 'sftp';

  constructor(
    readonly host: string,
    readonly user: string
  ) {}

  fetchSubmissions(): Promise<BeneficiarySubmission[]> {
    throw new ProviderConfigError(this.name, ['SFTP_TRANSPORT']);
  }
}

/** True when a field-data pull may run (flag + at least one source keyed). */
export function fieldDataDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.FIELD_DATA_DRIVER;
  const live = flag === 'live' || flag === 'production' || flag === 'sandbox';
  return live && Boolean(env.KOBO_BASE_URL || env.ODK_CENTRAL_BASE_URL || env.FIELD_DATA_SFTP_HOST);
}

/** Fail-closed factory; returns no sources while the driver is stub. */
export function createFieldDataSources(env: NodeJS.ProcessEnv = process.env): FieldDataSource[] {
  const flag = env.FIELD_DATA_DRIVER ?? 'stub';
  if (flag === 'stub') {
    return [];
  }
  const sources: FieldDataSource[] = [];
  if (env.KOBO_BASE_URL) {
    sources.push(
      new KoboToolboxClient(
        env.KOBO_BASE_URL,
        requireEnv('kobo', env, ['KOBO_API_TOKEN']),
        requireEnv('kobo', env, ['KOBO_ASSET_UID'])
      )
    );
  }
  if (env.ODK_CENTRAL_BASE_URL) {
    sources.push(
      new OdkCentralClient(
        env.ODK_CENTRAL_BASE_URL,
        requireEnv('odk', env, ['ODK_CENTRAL_TOKEN']),
        requireEnv('odk', env, ['ODK_PROJECT_ID']),
        requireEnv('odk', env, ['ODK_FORM_ID'])
      )
    );
  }
  if (env.FIELD_DATA_SFTP_HOST) {
    // Fail closed at boot: the SFTP transport is not approved yet.
    throw new ProviderConfigError('sftp', ['SFTP_TRANSPORT']);
  }
  return sources;
}
