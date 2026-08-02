/**
 * ODK Central / KoboToolbox beneficiary pull clients (wave P5a, matrix
 * Phase 3). Both fetch raw submission rows that the beneficiary-import
 * service validates, hashes and stages for admin confirmation. The SFTP
 * pull (partner MIS drop folders) shipped as a fail-closed scaffold in P5a;
 * wave P6b wires the real ssh2 transport, still fail-closed: the source is
 * only constructed when FIELD_DATA_SFTP_DRIVER is sandbox|live AND the
 * host/user/credential envs are present, otherwise boot raises
 * ProviderConfigError (no silent live calls).
 */
import { readFileSync } from 'node:fs';
import { Client as Ssh2Client, type FileEntry, type SFTPWrapper } from 'ssh2';
import {
  httpJson,
  requireEnv,
  ProviderConfigError,
  ProviderRequestError
} from './http.js';

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

/** A downloaded drop file was not JSON (or not a submission envelope). */
export class SftpParseError extends Error {
  constructor(readonly file: string, cause?: unknown) {
    super(
      `SFTP drop file '${file}' is not a parseable submission document: ` +
        `${cause instanceof Error ? cause.message : 'unexpected shape'}`
    );
    this.name = 'SftpParseError';
    this.cause = cause;
  }
}

export interface SftpFieldDataConfig {
  host: string;
  port: number;
  username: string;
  /** Inline PEM private key (preferred) or password auth. */
  privateKey?: string;
  password?: string;
  /** Remote drop directory polled for *.json submission files. */
  remoteDir: string;
  /** ssh2 readyTimeout (connect handshake budget). */
  connectTimeoutMs: number;
}

/** ssh2 connect handshake budget — matches the HTTP provider timeout. */
export const SFTP_CONNECT_TIMEOUT_MS = 5000;
const SFTP_DRIVER_FLAGS = new Set(['sandbox', 'live', 'production']);

/**
 * SFTP pull transport (wave P6b, ssh2): lists `remoteDir` for *.json drop
 * files, downloads each over the same session and parses the rows. Accepted
 * document shapes mirror the HTTP clients: a bare array of submissions or an
 * envelope (`{ results: [...] }` / `{ value: [...] }`). One bad drop file
 * fails the pull with SftpParseError so operators notice a mis-shaped
 * partner export instead of silently importing a partial batch.
 */
export class SftpFieldDataClient implements FieldDataSource {
  readonly name = 'sftp';

  constructor(private readonly config: SftpFieldDataConfig) {}

  async fetchSubmissions(): Promise<BeneficiarySubmission[]> {
    return this.withSftp(async (sftp) => {
      const entries = await this.listDropFiles(sftp);
      const rows: BeneficiarySubmission[] = [];
      for (const entry of entries) {
        const file = `${this.config.remoteDir.replace(/\/$/, '')}/${entry.filename}`;
        const text = await this.download(sftp, file);
        rows.push(...this.parse(file, text));
      }
      return rows;
    });
  }

  /** Opens one ssh2 session and hands the SFTP channel to `fn`. */
  private async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const conn = new Ssh2Client();
    try {
      await new Promise<void>((resolve, reject) => {
        conn
          .on('ready', () => resolve())
          .on('error', (error: Error) =>
            reject(new ProviderRequestError(this.name, 'network', error))
          )
          .connect({
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
            privateKey: this.config.privateKey,
            password: this.config.password,
            readyTimeout: this.config.connectTimeoutMs
          });
      });
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        conn.sftp((error, channel) =>
          error
            ? reject(new ProviderRequestError(this.name, 'network', error))
            : resolve(channel)
        );
      });
      return await fn(sftp);
    } finally {
      conn.end();
    }
  }

  private listDropFiles(sftp: SFTPWrapper): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      sftp.readdir(this.config.remoteDir, (error, list) => {
        if (error) {
          reject(new ProviderRequestError(this.name, 'network', error));
          return;
        }
        resolve(list.filter((entry) => entry.filename.toLowerCase().endsWith('.json')));
      });
    });
  }

  private download(sftp: SFTPWrapper, file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      sftp
        .createReadStream(file)
        .on('data', (chunk: Buffer | string) =>
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        )
        .on('error', (error: Error) =>
          reject(new ProviderRequestError(this.name, 'network', error))
        )
        .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  /** Parses one drop file into submission rows; SftpParseError on bad input. */
  private parse(file: string, text: string): BeneficiarySubmission[] {
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new SftpParseError(file, error);
    }
    const rows = asRows(document, 'results');
    if (rows.length === 0 && !Array.isArray(document)) {
      const envelope = (document as Record<string, unknown>)?.['value'];
      if (Array.isArray(envelope)) {
        return envelope as BeneficiarySubmission[];
      }
      throw new SftpParseError(file);
    }
    return rows;
  }
}

/**
 * Builds the SFTP source from env, failing closed: FIELD_DATA_SFTP_DRIVER
 * must be sandbox|live and user + one credential (inline key, key path or
 * password) must be present, otherwise ProviderConfigError lists the gaps.
 */
function createSftpSource(env: NodeJS.ProcessEnv): FieldDataSource {
  const missing: string[] = [];
  const flag = (env.FIELD_DATA_SFTP_DRIVER ?? 'stub').trim().toLowerCase();
  if (!SFTP_DRIVER_FLAGS.has(flag)) {
    missing.push('FIELD_DATA_SFTP_DRIVER');
  }
  if (!env.FIELD_DATA_SFTP_USER) {
    missing.push('FIELD_DATA_SFTP_USER');
  }
  let privateKey = env.FIELD_DATA_SFTP_PRIVATE_KEY;
  if (!privateKey && env.FIELD_DATA_SFTP_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(env.FIELD_DATA_SFTP_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      missing.push('FIELD_DATA_SFTP_PRIVATE_KEY_PATH (unreadable)');
    }
  }
  if (!privateKey && !env.FIELD_DATA_SFTP_PASSWORD) {
    missing.push('FIELD_DATA_SFTP_PRIVATE_KEY|FIELD_DATA_SFTP_PRIVATE_KEY_PATH|FIELD_DATA_SFTP_PASSWORD');
  }
  if (missing.length > 0) {
    throw new ProviderConfigError('sftp', missing);
  }
  return new SftpFieldDataClient({
    host: env.FIELD_DATA_SFTP_HOST as string,
    port: Number(env.FIELD_DATA_SFTP_PORT ?? 22),
    username: env.FIELD_DATA_SFTP_USER as string,
    privateKey,
    password: env.FIELD_DATA_SFTP_PASSWORD,
    remoteDir: env.FIELD_DATA_SFTP_REMOTE_DIR ?? '/drop',
    connectTimeoutMs: Number(env.FIELD_DATA_SFTP_TIMEOUT_MS ?? SFTP_CONNECT_TIMEOUT_MS)
  });
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
    // Fail closed at boot unless the SFTP driver flag + credentials are set.
    sources.push(createSftpSource(env));
  }
  return sources;
}
