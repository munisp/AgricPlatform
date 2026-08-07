/**
 * External animal-ID authority port (wave-livestock-passport): the national
 * animal identification authority / RFID tag registry consulted at passport
 * issue time to corroborate the ear tag / electronic ID the farmer declared.
 *
 * Doctrine (non-negotiable):
 * - STUB is the default (no env configured) and returns a DETERMINISTIC,
 *   hash-seeded verdict per tag, honestly labelled basis:'stub' — the UI,
 *   API payloads and docs always surface that no government registry was
 *   actually contacted. We NEVER claim a state/federal integration exists.
 * - LIVE (ANIMAL_ID_AUTHORITY_MODE=live, or ANIMAL_ID_AUTHORITY_URL set)
 *   requires BOTH ANIMAL_ID_AUTHORITY_URL and ANIMAL_ID_AUTHORITY_API_KEY and
 *   fails closed: the factory throws ProviderConfigError at BOOT when the
 *   live flag is set without full config, and a configured-but-unreachable
 *   authority surfaces a provider error which the service maps to 503 — the
 *   stub is NEVER silently substituted.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../integrations/drivers/http.js';

/** Per-attempt timeout. */
export const AUTHORITY_TIMEOUT_MS = 5_000;
/** Retries after the first attempt (3 attempts total) on 5xx/network. */
export const AUTHORITY_RETRIES = 2;

export interface TagCheckInput {
  animalId: string;
  species: string;
  state: string;
  tagId?: string;
  eid?: string;
}

export interface TagCheckResult {
  /** Whether the authority confirms the tag/eid registration. */
  registered: boolean;
  /** Authority-side registration reference (stub-prefixed when simulated). */
  registryReference?: string;
  /** Honest provenance label. */
  basis: 'stub' | 'live';
  detail: string;
}

export interface AnimalIdAuthorityStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface AnimalIdAuthorityProvider {
  readonly name: 'stub' | 'http';
  checkTag(input: TagCheckInput): Promise<TagCheckResult>;
  status(): Promise<AnimalIdAuthorityStatus>;
}

export const ANIMAL_ID_AUTHORITY_PROVIDER = Symbol('ANIMAL_ID_AUTHORITY_PROVIDER');

/** Deterministic 32-bit FNV-1a hash — stub verdicts are stable per tag. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic labelled fixture: the verdict is a pure function of the
 * tag/eid (90% of tags resolve as 'registered' so both paths are testable),
 * and the registry reference is visibly STUB-prefixed so nothing downstream
 * can mistake it for a real authority record.
 */
export class StubAnimalIdAuthorityProvider implements AnimalIdAuthorityProvider {
  readonly name = 'stub' as const;

  checkTag(input: TagCheckInput): Promise<TagCheckResult> {
    const subject = input.tagId ?? input.eid ?? input.animalId;
    const hash = fnv1a(`animal-id:${subject}`);
    const registered = hash % 10 !== 0;
    return Promise.resolve({
      registered,
      registryReference: `STUB-NAIS-${hash.toString(16).padStart(8, '0')}`,
      basis: 'stub',
      detail:
        'STUB — deterministic simulated tag check; no national animal-ID authority or RFID registry was contacted. ' +
        `Tag '${subject}' ${registered ? 'resolves' : 'does not resolve'} in the simulated registry.`
    });
  }

  status(): Promise<AnimalIdAuthorityStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub provider: deterministic simulated tag checks. Set ANIMAL_ID_AUTHORITY_MODE=live with ANIMAL_ID_AUTHORITY_URL and ANIMAL_ID_AUTHORITY_API_KEY to enable a live authority integration (not yet contracted — external gate).'
    });
  }
}

/** Live authority contract (docs/livestock-passport.md §authority contract). */
interface AuthorityTagVerifyResponse {
  registered?: boolean;
  registry_reference?: string;
}

/**
 * Live driver against a contracted national animal-ID authority / RFID
 * registry API. 5s timeout per attempt, 2 retries on 5xx/network (never on
 * 4xx). No such integration is contracted yet — this driver ships fail-closed
 * behind explicit configuration.
 */
export class HttpAnimalIdAuthorityProvider implements AnimalIdAuthorityProvider {
  readonly name = 'http' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async checkTag(input: TagCheckInput): Promise<TagCheckResult> {
    const query = new URLSearchParams({ animalId: input.animalId });
    if (input.tagId) query.set('tagId', input.tagId);
    if (input.eid) query.set('eid', input.eid);
    const response = await this.requestWithRetries(
      `${this.baseUrl}/v1/tags/verify?${query.toString()}`
    );
    return {
      registered: Boolean(response.registered),
      registryReference: response.registry_reference,
      basis: 'live',
      detail: response.registered
        ? 'Tag registration confirmed by the configured animal-ID authority.'
        : 'Tag NOT confirmed by the configured animal-ID authority.'
    };
  }

  async status(): Promise<AnimalIdAuthorityStatus> {
    try {
      await httpJson('animal-id-authority', `${this.baseUrl}/healthz`, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey },
        timeoutMs: 2_500
      });
      return { configured: true, healthy: true, detail: 'Animal-ID authority reachable.' };
    } catch {
      return {
        configured: true,
        healthy: false,
        detail: `Animal-ID authority unreachable at ${this.baseUrl}.`
      };
    }
  }

  private async requestWithRetries(url: string): Promise<AuthorityTagVerifyResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= AUTHORITY_RETRIES; attempt += 1) {
      try {
        return await httpJson<AuthorityTagVerifyResponse>('animal-id-authority', url, {
          method: 'GET',
          headers: { 'x-api-key': this.apiKey },
          timeoutMs: AUTHORITY_TIMEOUT_MS
        });
      } catch (error) {
        // 4xx is a contract violation — retrying cannot help.
        if (error instanceof ProviderHttpError && error.status < 500) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured provider. Default is the stub. The live driver is
 * selected explicitly (ANIMAL_ID_AUTHORITY_MODE=live) or implicitly by
 * setting ANIMAL_ID_AUTHORITY_URL; either way BOTH the URL and the API key
 * are required — the factory throws ProviderConfigError at boot otherwise
 * (production fail-closed when the live flag is set without config).
 */
export function createAnimalIdAuthorityProvider(
  env: NodeJS.ProcessEnv = process.env
): AnimalIdAuthorityProvider {
  const mode = env.ANIMAL_ID_AUTHORITY_MODE?.trim().toLowerCase();
  const url = env.ANIMAL_ID_AUTHORITY_URL?.trim();
  if (mode === 'live' || url) {
    const baseUrl = requireEnv('animal-id-authority', env, ['ANIMAL_ID_AUTHORITY_URL']).replace(
      /\/+$/,
      ''
    );
    const apiKey = requireEnv('animal-id-authority', env, ['ANIMAL_ID_AUTHORITY_API_KEY']);
    return new HttpAnimalIdAuthorityProvider(baseUrl, apiKey);
  }
  if (mode && mode !== 'stub') {
    throw new ProviderConfigError('animal-id-authority', ['ANIMAL_ID_AUTHORITY_MODE']);
  }
  return new StubAnimalIdAuthorityProvider();
}
