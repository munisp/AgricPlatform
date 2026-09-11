import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import { trace, type Attributes } from '@opentelemetry/api';
import { Observable } from 'rxjs';

/**
 * Tenant attribution for traces and logs (integration map §7).
 *
 * There is no platform tenant model in this branch yet (no partner_members /
 * stage24 content). The per-request tenant identity is therefore derived
 * from what the existing guards attach to the request:
 *   - `request.partner.clientId`  (partner-auth.guard.ts:70) — partner org id
 *   - `request.user`              (roles.guard.ts:62) — cooperative/programme
 *     id when such a claim exists on the user record, else `user:<id>`
 *   - `anonymous`                 — unauthenticated requests
 * When real tenant binding lands it will flow through the same two guards and
 * only `deriveTenantId` needs to change.
 */

/** Span/log attribute key used for tenant attribution. */
export const TENANT_ATTRIBUTE = 'tenant.id';

interface TenantScope {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/**
 * Async-local tenant scope. `runWithTenant` makes the tenant id available to
 * everything awaited inside `fn` (handlers, services, driver calls), and
 * `currentTenantId` reads it back — both are safe to call with no active
 * scope (returns undefined).
 */
export const TenantContext = {
  runWithTenant<T>(tenantId: string, fn: () => T): T {
    return storage.run({ tenantId }, fn);
  },
  currentTenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  }
};

/** Minimal request shape the interceptor reads (guards attach user/partner). */
export interface AttributedRequest {
  user?: unknown;
  partner?: unknown;
}

/** Derives the tenant id for a request. Pure; never throws. */
export function deriveTenantId(request: AttributedRequest | undefined): string {
  const partner = request?.partner as { clientId?: unknown } | undefined;
  if (typeof partner?.clientId === 'string' && partner.clientId.length > 0) {
    return partner.clientId;
  }
  const user = request?.user as
    | { id?: unknown; cooperativeId?: unknown; programmeId?: unknown }
    | undefined;
  if (user) {
    if (typeof user.cooperativeId === 'string' && user.cooperativeId.length > 0) {
      return `cooperative:${user.cooperativeId}`;
    }
    if (typeof user.programmeId === 'string' && user.programmeId.length > 0) {
      return `programme:${user.programmeId}`;
    }
    if (typeof user.id === 'string' && user.id.length > 0) {
      return `user:${user.id}`;
    }
  }
  return 'anonymous';
}

/** Stamps `tenant.id` on the active span when one exists; never throws. */
export function stampTenantOnActiveSpan(tenantId: string): void {
  try {
    trace.getActiveSpan()?.setAttribute(TENANT_ATTRIBUTE, tenantId);
  } catch {
    // Telemetry must never break the request path.
  }
}

/**
 * Attribute bag for manual spans (Stage 25.2 drivers): merges the current
 * tenant id (when a scope is active) with caller-supplied attributes.
 */
export function spanAttributes(extra: Attributes = {}): Attributes {
  const tenantId = TenantContext.currentTenantId();
  return tenantId ? { ...extra, [TENANT_ATTRIBUTE]: tenantId } : { ...extra };
}

/**
 * Global interceptor: derives the tenant id from the request (populated by
 * RolesGuard / PartnerAuthGuard, which run before interceptors), runs the
 * handler inside the async-local tenant scope, and stamps `tenant.id` on the
 * current span. Non-HTTP contexts (e.g. RPC) pass through untouched.
 */
@Injectable()
export class TenantAttributionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<AttributedRequest>();
    const tenantId = deriveTenantId(request);
    return new Observable<unknown>((subscriber) => {
      const subscription = TenantContext.runWithTenant(tenantId, () => {
        stampTenantOnActiveSpan(tenantId);
        return next.handle().subscribe(subscriber);
      });
      return () => subscription.unsubscribe();
    });
  }
}
