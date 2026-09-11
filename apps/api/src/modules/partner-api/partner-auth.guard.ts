import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PARTNER_CLIENT_REPOSITORY } from '../../database/persistence.tokens.js';
import type { PartnerClientRepository } from '../../database/repositories/partner-api.repository.js';
import { PartnerAuthService } from './partner-auth.service.js';
import { PartnerRateService } from './partner-rate.service.js';
import { PARTNER_SCOPES_KEY } from './partner-scopes.decorator.js';

export interface PartnerRequestIdentity {
  /** M2M client id, or `apikey:<owner>` for developer-key requests. */
  clientId: string;
  scopes: string[];
  sandbox: boolean;
  /** Developer API key owner, when authenticated via x-api-key. */
  ownerUserId?: string;
  /**
   * Tenant binding (Stage 24, audit A2-2): the partner organisation the
   * client was bound to at registration, carried as a token claim. Absent
   * for developer API keys and pre-Stage-24 (unbound) clients — both fail
   * closed on tenant-parameterised routes.
   */
  partnerId?: string;
}

interface PartnerRequest {
  headers: Record<string, string | string[] | undefined>;
  partner?: PartnerRequestIdentity;
}

/**
 * Scope-checking guard for the partner API surface (wave P5d). Accepts a
 * client-credentials access token (`Authorization: Bearer`, audience
 * `partner`) or a developer API key (`x-api-key`), enforces the route's
 * declared scopes (403 on denial) and applies the per-client rate bucket
 * (429 when empty; default 1000 req/min with a full-bucket burst policy).
 */
@Injectable()
export class PartnerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: PartnerAuthService,
    private readonly rate: PartnerRateService,
    @Inject(PARTNER_CLIENT_REPOSITORY) private readonly clients: PartnerClientRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<string[]>(PARTNER_SCOPES_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? [];
    const request = context.switchToHttp().getRequest<PartnerRequest>();
    const identity = await this.resolveIdentity(request);

    const missing = required.filter((scope) => !identity.scopes.includes(scope));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing partner scope(s): ${missing.join(', ')}`);
    }

    const limit = await this.rateLimitFor(identity);
    const remaining = await this.rate.consume(identity.clientId, limit);
    if (remaining === null) {
      throw new HttpException(
        `Partner rate limit exceeded (${limit} requests per minute)`,
        429
      );
    }

    request.partner = identity;
    return true;
  }

  private async resolveIdentity(request: PartnerRequest): Promise<PartnerRequestIdentity> {
    const authorization = request.headers['authorization'];
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;

    if (bearer) {
      try {
        return await this.auth.verifyToken(bearer);
      } catch (error) {
        throw new UnauthorizedException(
          `Invalid partner token: ${error instanceof Error ? error.message : 'verification failed'}`
        );
      }
    }

    const apiKeyHeader = request.headers['x-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    if (apiKey) {
      const key = await this.auth.verifyApiKey(apiKey);
      if (!key) {
        throw new UnauthorizedException('Invalid or revoked API key');
      }
      return {
        clientId: `apikey:${key.ownerUserId}`,
        scopes: key.scopes,
        sandbox: key.sandbox,
        ownerUserId: key.ownerUserId
      };
    }

    throw new UnauthorizedException(
      'Partner authentication required (Bearer access token or x-api-key)'
    );
  }

  private async rateLimitFor(identity: PartnerRequestIdentity): Promise<number> {
    if (identity.ownerUserId) {
      return 1000; // developer keys use the default bucket
    }
    const client = await this.clients.findOne({ clientId: identity.clientId });
    return client?.rateLimitPerMin ?? 1000;
  }
}

/** Reads the authenticated partner identity from a request. */
export function partnerIdentity(request: PartnerRequest): PartnerRequestIdentity {
  if (!request.partner) {
    throw new UnauthorizedException('Partner identity is not resolved');
  }
  return request.partner;
}

/**
 * Tenant binding enforcement (Stage 24, audit A2-2): tenant-parameterised
 * routes (`:partnerId`) require the authenticated client's bound partner
 * organisation to match the path parameter exactly. Unbound identities
 * (developer API keys, pre-Stage-24 clients) are refused — fail closed.
 */
export function assertPartnerTenant(
  identity: PartnerRequestIdentity,
  partnerId: string
): void {
  if (!identity.partnerId) {
    throw new ForbiddenException(
      'This credential is not bound to a partner organisation; tenant-scoped routes require a bound client-credentials token'
    );
  }
  if (identity.partnerId !== partnerId) {
    throw new ForbiddenException(
      `Client is bound to partner '${identity.partnerId}' and cannot access '${partnerId}'`
    );
  }
}
