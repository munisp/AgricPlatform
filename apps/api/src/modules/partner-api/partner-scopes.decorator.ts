import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const PARTNER_SCOPES_KEY = 'partner:scopes';

/**
 * Declares the partner API scopes a route requires. Checked by
 * PartnerAuthGuard against the access token's scope claims (or a developer
 * API key's stored scopes). The swagger extension lets the Wave P catalogue
 * generator carry scopes into the developer-portal docs without hand-edits.
 */
export const PartnerScopes = (...scopes: string[]) =>
  applyDecorators(SetMetadata(PARTNER_SCOPES_KEY, scopes), ApiExtension('x-partner-scopes', scopes));

/**
 * Every scope string honoured by a @PartnerScopes route anywhere in the API
 * (partner-api, portfolio scorecards, insurance, traceability, credit
 * passport / coop score). This is the issuable-scope whitelist for
 * developer API keys (OB-08): a key whose scope no route consumes is dead
 * capability, so requests for unknown scope strings are rejected with 400
 * instead of being silently persisted.
 *
 * When a new @PartnerScopes route lands, add its scope here.
 */
export const PARTNER_API_SCOPES = [
  'applications:read',
  'credit-passport:read',
  'disbursements:write',
  'enrolments:write',
  'farm_data:write',
  'impact:read',
  'insurance:read',
  'portfolio:read',
  'profile:read',
  'programmes:read',
  'traceability:dds',
  'traceability:read',
  'traceability:write',
  'webhooks:manage'
] as const;

export type PartnerApiScope = (typeof PARTNER_API_SCOPES)[number];
