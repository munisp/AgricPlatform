/**
 * AuthorizationCheck drivers (wave FABRIC): relationship-based
 * authorization behind one port. The stub driver is the DEFAULT and
 * reproduces the current RolesGuard/ownership logic exactly (owner or
 * admin) — RolesGuard stays the enforcement point everywhere. Setting
 * AUTHORIZATION_DRIVER=permify selects the Permify REST driver, which
 * REQUIRES PERMIFY_URL and fails closed: the factory throws
 * ProviderConfigError at boot when the URL is absent, and check failures
 * raise ProviderHttpError/ProviderRequestError (callers map to 503, deny
 * by default) — never a silent fallback to role checks.
 *
 * Proof scope: ONE resource — credit loan read (`credit_loan` / `read`),
 * wired into GET /api/v1/loans/:id only when the permify driver is
 * selected. The Permify schema/relationship tuples must be provisioned
 * out-of-band (see docs/integration-fabric.md); this driver performs no
 * schema writes.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../../modules/integrations/drivers/http.js';

/** DI token for the selected AuthorizationCheck driver. */
export const AUTHORIZATION_CHECK = Symbol('AUTHORIZATION_CHECK');

export interface AuthorizationSubject {
  userId: string;
  roles: readonly string[];
}

/** Proof-of-port action set (deliberately narrow). */
export type AuthorizationAction = 'read';

export interface AuthorizationResource {
  type: 'credit_loan';
  id: string;
  /** Owning user (applicant), when known — used by the stub driver. */
  ownerId?: string;
}

export interface AuthorizationCheckStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface AuthorizationCheck {
  readonly name: 'stub' | 'permify';
  can(
    subject: AuthorizationSubject,
    action: AuthorizationAction,
    resource: AuthorizationResource
  ): Promise<boolean>;
  status(): Promise<AuthorizationCheckStatus>;
}

/**
 * Default driver: the current platform logic — for `credit_loan`/`read`
 * this mirrors assertSelfOrAdmin (common/auth/ownership.ts): the applicant
 * themselves or an admin may read. Unknown resource/action combinations
 * DENY (fail closed).
 */
export class StubAuthorizationCheck implements AuthorizationCheck {
  readonly name = 'stub' as const;

  can(
    subject: AuthorizationSubject,
    action: AuthorizationAction,
    resource: AuthorizationResource
  ): Promise<boolean> {
    if (resource.type === 'credit_loan' && action === 'read') {
      return Promise.resolve(
        subject.roles.includes('admin') || subject.userId === resource.ownerId
      );
    }
    return Promise.resolve(false);
  }

  status(): Promise<AuthorizationCheckStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: in-process role/ownership checks (current RolesGuard logic). ' +
        'Set AUTHORIZATION_DRIVER=permify and PERMIFY_URL for relationship-based checks.'
    });
  }
}

interface PermifyCheckResponse {
  can?: string;
}

/**
 * Live Permify driver over the REST API (plain fetch — no SDK needed).
 * POST {PERMIFY_URL}/v1/tenants/{tenant}/permissions/check with the
 * credit_loan entity and user subject; RESULT_ALLOWED maps to true,
 * anything else (including transport/HTTP errors, which throw) fails
 * closed.
 */
export class PermifyAuthorizationCheck implements AuthorizationCheck {
  readonly name = 'permify' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly options: { tenantId?: string } = {}
  ) {}

  get tenantId(): string {
    return this.options.tenantId?.trim() || 't1';
  }

  async can(
    subject: AuthorizationSubject,
    action: AuthorizationAction,
    resource: AuthorizationResource
  ): Promise<boolean> {
    const response = await httpJson<PermifyCheckResponse>(
      'permify',
      `${this.baseUrl.replace(/\/+$/, '')}/v1/tenants/${encodeURIComponent(this.tenantId)}/permissions/check`,
      {
        body: {
          metadata: { schema_version: '', snap_token: '', depth: 20 },
          entity: { type: resource.type, id: resource.id },
          permission: action,
          subject: { type: 'user', id: subject.userId }
        }
      }
    );
    return response.can === 'RESULT_ALLOWED';
  }

  status(): Promise<AuthorizationCheckStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        `Permify REST configured at ${this.baseUrl} (tenant ${this.tenantId}). ` +
        'Reachability is verified at call time — check failures fail closed (deny + 503).'
    });
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured driver. Default is the stub (current RolesGuard
 * logic); AUTHORIZATION_DRIVER=permify requires PERMIFY_URL and fails
 * closed with ProviderConfigError otherwise.
 */
export function createAuthorizationCheck(
  env: NodeJS.ProcessEnv = process.env
): AuthorizationCheck {
  const flag = (env.AUTHORIZATION_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'permify') {
    const baseUrl = requireEnv('permify', env, ['PERMIFY_URL']);
    return new PermifyAuthorizationCheck(baseUrl, { tenantId: env.PERMIFY_TENANT_ID });
  }
  return new StubAuthorizationCheck();
}
