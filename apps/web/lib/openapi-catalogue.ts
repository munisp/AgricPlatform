/**
 * Hand-maintained endpoint catalogue for the developer portal
 * (wave P5d). Mirrors the NestJS route metadata; kept typed so the docs
 * page can render it without a swagger dependency.
 */

export type CatalogueAuth = 'client-credentials' | 'api-key' | 'user-token' | 'none';

export interface CatalogueEndpoint {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  summary: string;
  auth: CatalogueAuth;
  /** Required partner scopes (client-credentials / api-key routes). */
  scopes?: string[];
  requestBody?: string;
  response: string;
}

export interface CatalogueSection {
  id: string;
  title: string;
  description: string;
  endpoints: CatalogueEndpoint[];
}

export const OPENAPI_CATALOGUE: CatalogueSection[] = [
  {
    id: 'authentication',
    title: 'Authentication',
    description:
      'Machine-to-machine clients exchange credentials for short-lived access tokens ' +
      '(audience `partner`, scope claims, 15 minute TTL). Developers can also issue ' +
      'sandbox API keys from the portal; keys are shown once and stored hashed.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/v1/partner/oauth/token',
        summary: 'Client-credentials grant (OAuth2)',
        auth: 'none',
        requestBody: '{ grant_type: "client_credentials", client_id, client_secret }',
        response: '{ access_token, token_type: "Bearer", expires_in, scope, sandbox }'
      },
      {
        method: 'POST',
        path: '/api/v1/partner/developer-keys',
        summary: 'Issue a developer API key (plaintext shown once)',
        auth: 'user-token',
        requestBody: '{ scopes: string[] }',
        response: '{ id, prefix, scopes, sandbox, createdAt, key }'
      },
      {
        method: 'GET',
        path: '/api/v1/partner/developer-keys',
        summary: 'List own API keys (hashes never exposed)',
        auth: 'user-token',
        response: '[{ id, prefix, scopes, sandbox, revokedAt, createdAt }]'
      },
      {
        method: 'DELETE',
        path: '/api/v1/partner/developer-keys/:id',
        summary: 'Revoke an own API key',
        auth: 'user-token',
        response: '{ id, revokedAt }'
      }
    ]
  },
  {
    id: 'partner-reads',
    title: 'Consented reads',
    description:
      'Member-level data only leaves the platform when the member holds an active ' +
      '`partner_data_sharing` consent; aggregates never contain PII. All routes accept ' +
      'a partner access token or an API key with the listed scope.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/partner/participation/:partnerId',
        summary: 'Programme participation (consented members only)',
        auth: 'client-credentials',
        scopes: ['programmes:read'],
        response: '[{ userId, name, state? }]'
      },
      {
        method: 'GET',
        path: '/api/v1/partner/impact/:partnerId',
        summary: 'Aggregate impact metrics (DFI impact pull)',
        auth: 'client-credentials',
        scopes: ['impact:read'],
        response:
          '{ partnerId, programmes, participants, consentedParticipants, applications, completedTrainings }'
      },
      {
        method: 'GET',
        path: '/api/v1/partner/applications/count/:partnerId',
        summary: 'Application count for a partner',
        auth: 'client-credentials',
        scopes: ['applications:read'],
        response: '{ partnerId, applications }'
      },
      {
        method: 'GET',
        path: '/api/v1/partner/members/:userId/profile',
        summary: 'Consented member profile lookup (lender credit check)',
        auth: 'api-key',
        scopes: ['profile:read'],
        response: '{ user, profile, enrolments } — 403 without active consent'
      },
      {
        method: 'GET',
        path: '/api/v1/advisory?kind=crop_calendar',
        summary: 'Crop calendar read',
        auth: 'api-key',
        response: '{ data: [{ id, kind, title, state?, crop?, body }], page, total }'
      },
      {
        method: 'GET',
        path: '/api/v1/opportunities',
        summary: 'Opportunity listing',
        auth: 'api-key',
        response: '{ data: [{ id, title, type, states, deadline }], page, total }'
      }
    ]
  },
  {
    id: 'partner-writes',
    title: 'Writes',
    description:
      'Mutations accept an `Idempotency-Key` header and are safe to retry. Successful ' +
      'writes publish domain events that fan out to subscribed webhooks.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/v1/partner/disbursements',
        summary: 'Record a disbursement event',
        auth: 'client-credentials',
        scopes: ['disbursements:write'],
        requestBody: '{ partnerId, userId, amountNgn, programmeId?, reference? }',
        response: '{ id, partnerId, userId, amountNgn, recordedAt }'
      },
      {
        method: 'POST',
        path: '/api/v1/partner/enrolments',
        summary: 'Record a partner programme enrolment (NGO enrolment push)',
        auth: 'client-credentials',
        scopes: ['enrolments:write'],
        requestBody: '{ partnerId, userId, programmeId, cohortLabel? }',
        response: '{ id, partnerId, userId, programmeId, recordedAt }'
      },
      {
        method: 'POST',
        path: '/api/v1/partner/farm-data',
        summary: 'farmOS-compatible farm data push (202 Accepted)',
        auth: 'client-credentials',
        scopes: ['farm_data:write'],
        requestBody: '{ userId, assets?: farmOS-asset[], logs?: farmOS-log[] }',
        response: '{ id, userId, accepted, receivedAt }'
      },
      {
        method: 'POST',
        path: '/api/v1/listings',
        summary: 'Marketplace item creation (on behalf of a member)',
        auth: 'user-token',
        requestBody: '{ title, category, priceNgn, quantityAvailable, state }',
        response: '{ id, sellerId, title, priceNgn, status }'
      }
    ]
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    description:
      'Outbound deliveries are POSTed as JSON with an HMAC signature header ' +
      '`X-Agric-Signature: sha256=<hmac>` over the exact request body, plus ' +
      '`X-Agric-Event` and `X-Agric-Delivery` headers. Verify against your ' +
      'subscription secret before processing.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/v1/partner/webhooks',
        summary: 'Create a subscription (secret returned once)',
        auth: 'client-credentials',
        scopes: ['webhooks:manage'],
        requestBody:
          '{ eventTypes: ("course.completed"|"enrolment.created"|"disbursement.recorded"|"programme_enrolment.recorded")[], targetUrl, secret }',
        response: '{ id, clientId, eventTypes, targetUrl, status, secret }'
      },
      {
        method: 'GET',
        path: '/api/v1/partner/webhooks',
        summary: 'List subscriptions (secrets omitted)',
        auth: 'client-credentials',
        scopes: ['webhooks:manage'],
        response: '[{ id, clientId, eventTypes, targetUrl, status, createdAt }]'
      },
      {
        method: 'DELETE',
        path: '/api/v1/partner/webhooks/:id',
        summary: 'Delete a subscription',
        auth: 'client-credentials',
        scopes: ['webhooks:manage'],
        response: '{ removed }'
      }
    ]
  },
  {
    id: 'embeds',
    title: 'Public embed feeds',
    description:
      'Anonymous, read-only JSON feeds backing the embeddable widgets. CORS-open, ' +
      'cache-friendly (60s), and contain no PII.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/embed/opportunities',
        summary: 'Opportunity directory embed feed',
        auth: 'none',
        response: '{ data: [{ id, title, type, states, deadline }], generatedAt }'
      },
      {
        method: 'GET',
        path: '/api/v1/embed/prices',
        summary: 'Commodity price ticker feed',
        auth: 'none',
        response: '{ data: [{ commodity, market, state, priceNgn, observedAt }], generatedAt }'
      },
      {
        method: 'GET',
        path: '/api/v1/embed/courses',
        summary: 'Course catalogue embed feed',
        auth: 'none',
        response: '{ data: [{ id, title, category, level, durationMinutes, language }] }'
      },
      {
        method: 'GET',
        path: '/api/v1/embed/member-cta',
        summary: 'NYFN member registration button configuration',
        auth: 'none',
        response: '{ data: { label, href, description } }'
      }
    ]
  }
];

/** Flat endpoint list (used by tests and the docs index). */
export function allEndpoints(): CatalogueEndpoint[] {
  return OPENAPI_CATALOGUE.flatMap((section) => section.endpoints);
}
