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
