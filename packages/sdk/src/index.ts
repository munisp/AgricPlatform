/**
 * @agric-platform/sdk — public TypeScript SDK for the AgricPlatform (NYFN)
 * partner API. fetch-based; runs on Node 18+ and in browsers.
 *
 * Auth modes:
 *  - API key (developer portal):      { apiKey: 'ak_sandbox_...' }
 *  - User token (OIDC bearer):        { userToken: '<jwt>' }
 *  - Client credentials (M2M):        { clientId, clientSecret } — the SDK
 *    obtains and caches short-lived partner access tokens automatically.
 */

export const SANDBOX_BASE_URL = 'https://api.sandbox.agricplatform.ng/api/v1';
export const LIVE_BASE_URL = 'https://api.agricplatform.ng/api/v1';

export type AgricAuth =
  | { apiKey: string }
  | { userToken: string }
  | { clientId: string; clientSecret: string };

export interface AgricClientOptions {
  auth: AgricAuth;
  /** Defaults to the sandbox environment. */
  baseUrl?: string;
  /** Injected fetch implementation (tests, custom agents). */
  fetch?: typeof fetch;
  /** Retries for idempotent reads and safe replays (default 3). */
  maxRetries?: number;
  /** Per-attempt timeout in ms (default 10_000). */
  timeoutMs?: number;
}

export class AgricApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = 'AgricApiError';
  }
}

export interface RequestOptions {
  /** Explicit idempotency key for a mutation (auto-generated otherwise). */
  idempotencyKey?: string;
}

// --- Partner API resource types (aligned with apps/api partner-api module) --

export interface ConsentedParticipant {
  userId: string;
  name: string;
  state?: string;
}

export interface PartnerImpactAggregate {
  partnerId: string;
  programmes: number;
  participants: number;
  consentedParticipants: number;
  applications: number;
  completedTrainings: number;
}

export interface MemberProfileResult {
  user: Record<string, unknown>;
  profile: Record<string, unknown>;
  enrolments: Array<Record<string, unknown>>;
}

export interface DisbursementEvent {
  id: string;
  partnerId: string;
  userId: string;
  amountNgn: number;
  programmeId?: string;
  reference?: string;
  recordedAt: string;
}

export interface WebhookSubscription {
  id: string;
  clientId: string;
  eventTypes: string[];
  targetUrl: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface AdvisoryItem {
  id: string;
  kind: string;
  title: string;
  state?: string;
  crop?: string;
  body: string;
  severity?: string;
  publishedAt: string;
}

export interface Opportunity {
  id: string;
  title: string;
  type: string;
  description: string;
  states?: string[];
  valueChains?: string[];
  eligibility?: string[];
  deadline: string;
  partnerId?: string;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  title: string;
  category: string;
  priceNgn: number;
  quantityAvailable: number;
  state: string;
  status: string;
}

export interface FarmDataPushResult {
  id: string;
  userId: string;
  accepted: boolean;
  receivedAt: string;
}

interface Envelope<T> {
  data: T;
}

interface ListEnvelope<T> {
  data: T[];
  page?: number;
  pageSize?: number;
  total?: number;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function randomKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgricClient {
  private readonly baseUrl: string;
  private readonly auth: AgricAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  readonly members: MembersResource;
  readonly advisory: AdvisoryResource;
  readonly opportunities: OpportunitiesResource;
  readonly marketplace: MarketplaceResource;
  readonly farm: FarmResource;
  readonly webhooks: WebhooksResource;
  readonly partner: PartnerResource;

  constructor(options: AgricClientOptions) {
    this.auth = options.auth;
    this.baseUrl = (options.baseUrl ?? SANDBOX_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 10_000;

    this.members = new MembersResource(this);
    this.advisory = new AdvisoryResource(this);
    this.opportunities = new OpportunitiesResource(this);
    this.marketplace = new MarketplaceResource(this);
    this.farm = new FarmResource(this);
    this.webhooks = new WebhooksResource(this);
    this.partner = new PartnerResource(this);
  }

  /** True when the client points at the sandbox environment. */
  get sandbox(): boolean {
    return this.baseUrl !== LIVE_BASE_URL;
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } & RequestOptions = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (MUTATION_METHODS.has(method)) {
      headers['idempotency-key'] = options.idempotencyKey ?? randomKey();
    }
    Object.assign(headers, await this.authHeaders());

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new AgricApiError(`HTTP ${response.status}`, response.status);
          await sleep(2 ** attempt * 100 + Math.random() * 50);
          continue;
        }
        if (!response.ok) {
          const body = await response.json().catch(() => undefined);
          const message =
            (body as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
          throw new AgricApiError(message, response.status, body);
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof AgricApiError && error.status < 500 && error.status !== 429) {
          throw error;
        }
        lastError = error;
        if (attempt < this.maxRetries) {
          await sleep(2 ** attempt * 100 + Math.random() * 50);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new AgricApiError('Request failed', 0);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if ('apiKey' in this.auth) {
      return { 'x-api-key': this.auth.apiKey };
    }
    if ('userToken' in this.auth) {
      return { authorization: `Bearer ${this.auth.userToken}` };
    }
    return { authorization: `Bearer ${await this.partnerToken()}` };
  }

  /** Client-credentials flow with cached short-lived token. */
  private async partnerToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 5_000) {
      return this.cachedToken.token;
    }
    if (!('clientId' in this.auth)) throw new AgricApiError('Not a M2M client', 0);
    const url = `${this.baseUrl}/partner/oauth/token`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new AgricApiError('Client credentials rejected', response.status);
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      token: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000
    };
    return body.access_token;
  }
}

/** Consented member lookups. */
export class MembersResource {
  constructor(private readonly client: AgricClient) {}

  /** Consented member profile (lender credit-check flow). 403 without consent. */
  async getProfile(userId: string): Promise<MemberProfileResult> {
    const envelope = await this.client.request<Envelope<MemberProfileResult>>(
      'GET',
      `/partner/members/${encodeURIComponent(userId)}/profile`
    );
    return envelope.data;
  }
}

/** Advisory content, including the crop calendar. */
export class AdvisoryResource {
  constructor(private readonly client: AgricClient) {}

  /** Crop calendar entries (optionally filtered by state and crop). */
  async getCropCalendar(filter: { state?: string; crop?: string } = {}): Promise<AdvisoryItem[]> {
    const envelope = await this.client.request<ListEnvelope<AdvisoryItem>>('GET', '/advisory', {
      query: { kind: 'crop_calendar', state: filter.state, crop: filter.crop }
    });
    return envelope.data;
  }
}

/** Public opportunity directory. */
export class OpportunitiesResource {
  constructor(private readonly client: AgricClient) {}

  async list(filter: { type?: string; state?: string } = {}): Promise<Opportunity[]> {
    const envelope = await this.client.request<ListEnvelope<Opportunity>>(
      'GET',
      '/opportunities',
      { query: { type: filter.type, state: filter.state } }
    );
    return envelope.data;
  }
}

/** Marketplace mutations (user-token auth). */
export class MarketplaceResource {
  constructor(private readonly client: AgricClient) {}

  /** Creates a listing; safe to retry via the idempotency key. */
  async createListing(
    input: {
      title: string;
      category: string;
      priceNgn: number;
      quantityAvailable: number;
      state: string;
      description?: string;
    },
    options: RequestOptions = {}
  ): Promise<MarketplaceListing> {
    const envelope = await this.client.request<Envelope<MarketplaceListing>>(
      'POST',
      '/listings',
      { body: input, idempotencyKey: options.idempotencyKey }
    );
    return envelope.data;
  }
}

/** farmOS-compatible farm data pushes (partner M2M). */
export class FarmResource {
  constructor(private readonly client: AgricClient) {}

  /** Pushes a farmOS-style asset/log payload for a member. */
  async pushFarmData(
    input: { userId: string; assets?: unknown[]; logs?: unknown[] },
    options: RequestOptions = {}
  ): Promise<FarmDataPushResult> {
    const envelope = await this.client.request<Envelope<FarmDataPushResult>>(
      'POST',
      '/partner/farm-data',
      { body: input, idempotencyKey: options.idempotencyKey }
    );
    return envelope.data;
  }
}

/** Outbound webhook subscription management (M2M token required). */
export class WebhooksResource {
  constructor(private readonly client: AgricClient) {}

  /** Creates a subscription; the signing secret is returned once. */
  async create(input: {
    eventTypes: string[];
    targetUrl: string;
    secret: string;
  }): Promise<WebhookSubscription & { secret: string }> {
    const envelope = await this.client.request<
      Envelope<WebhookSubscription & { secret: string }>
    >('POST', '/partner/webhooks', { body: input });
    return envelope.data;
  }

  /** Lists the client's subscriptions (secrets are never returned). */
  async list(): Promise<WebhookSubscription[]> {
    const envelope = await this.client.request<Envelope<WebhookSubscription[]>>(
      'GET',
      '/partner/webhooks'
    );
    return envelope.data;
  }

  async delete(id: string): Promise<boolean> {
    const envelope = await this.client.request<Envelope<{ removed: boolean }>>(
      'DELETE',
      `/partner/webhooks/${encodeURIComponent(id)}`
    );
    return envelope.data.removed;
  }
}

/** Partner programme metrics and write hooks (M2M or scoped API key). */
export class PartnerResource {
  constructor(private readonly client: AgricClient) {}

  /** Consented programme participation. */
  async getParticipation(partnerId: string): Promise<ConsentedParticipant[]> {
    const envelope = await this.client.request<Envelope<ConsentedParticipant[]>>(
      'GET',
      `/partner/participation/${encodeURIComponent(partnerId)}`
    );
    return envelope.data;
  }

  /** Aggregate impact metrics (DFI impact pull). */
  async getImpact(partnerId: string): Promise<PartnerImpactAggregate> {
    const envelope = await this.client.request<Envelope<PartnerImpactAggregate>>(
      'GET',
      `/partner/impact/${encodeURIComponent(partnerId)}`
    );
    return envelope.data;
  }

  /** Application count for a partner. */
  async getApplicationCount(partnerId: string): Promise<number> {
    const envelope = await this.client.request<Envelope<{ applications: number }>>(
      'GET',
      `/partner/applications/count/${encodeURIComponent(partnerId)}`
    );
    return envelope.data.applications;
  }

  /** Records a disbursement event (webhook fanned out to subscribers). */
  async recordDisbursement(
    input: {
      partnerId: string;
      userId: string;
      amountNgn: number;
      programmeId?: string;
      reference?: string;
    },
    options: RequestOptions = {}
  ): Promise<DisbursementEvent> {
    const envelope = await this.client.request<Envelope<DisbursementEvent>>(
      'POST',
      '/partner/disbursements',
      { body: input, idempotencyKey: options.idempotencyKey }
    );
    return envelope.data;
  }

  /** Records a partner programme enrolment (NGO enrolment push). */
  async recordEnrolment(
    input: { partnerId: string; userId: string; programmeId: string; cohortLabel?: string },
    options: RequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const envelope = await this.client.request<Envelope<Record<string, unknown>>>(
      'POST',
      '/partner/enrolments',
      { body: input, idempotencyKey: options.idempotencyKey }
    );
    return envelope.data;
  }
}

/** Convenience factory. */
export function createClient(options: AgricClientOptions): AgricClient {
  return new AgricClient(options);
}
