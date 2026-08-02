import { SetMetadata } from '@nestjs/common';

export const PARTNER_SCOPES_KEY = 'partner:scopes';

/**
 * Declares the partner API scopes a route requires. Checked by
 * PartnerAuthGuard against the access token's scope claims (or a developer
 * API key's stored scopes).
 */
export const PartnerScopes = (...scopes: string[]) => SetMetadata(PARTNER_SCOPES_KEY, scopes);
