/**
 * GENERATED FILE — DO NOT HAND-EDIT.
 * Regenerate with: cd apps/api && npx vitest run test/tools/generate-openapi-catalogue.spec.ts
 * Source of truth: the NestJS OpenAPI document served at /api/v1/openapi.json.
 */

export type CatalogueAuth = 'client-credentials' | 'api-key' | 'user-token' | 'none';

export interface CatalogueEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
      'Machine-to-machine clients exchange credentials for short-lived access tokens (audience `partner`, scope claims, 15 minute TTL). Developers can also issue sandbox API keys from the portal; keys are shown once and stored hashed.',
    endpoints: [
      {
        "method": "GET",
        "path": "/api/v1/partner/developer-keys",
        "summary": "List own API keys (hashes never exposed)",
        "auth": "user-token",
        "response": "{ 200 }"
      },
      {
        "method": "POST",
        "path": "/api/v1/partner/developer-keys",
        "summary": "Issue an API key (plaintext shown once)",
        "auth": "user-token",
        "response": "{ 201 }"
      },
      {
        "method": "DELETE",
        "path": "/api/v1/partner/developer-keys/{id}",
        "summary": "Revoke an own API key",
        "auth": "user-token",
        "response": "{ 200 }"
      },
      {
        "method": "POST",
        "path": "/api/v1/partner/oauth/token",
        "summary": "Client-credentials grant (partner access token)",
        "auth": "none",
        "response": "{ 200 }"
      }
    ]
  },
  {
    id: 'partner-reads',
    title: 'Consented reads',
    description:
      'Read-only federation queries for authorised partners.',
    endpoints: [
      {
        "method": "GET",
        "path": "/api/v1/partner/applications/count/{partnerId}",
        "summary": "Application count for a partner (aggregate)",
        "auth": "client-credentials",
        "scopes": [
          "applications:read"
        ],
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/partner/impact/{partnerId}",
        "summary": "Aggregate impact metrics (counts only, no PII)",
        "auth": "client-credentials",
        "scopes": [
          "impact:read"
        ],
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/partner/members/{userId}/profile",
        "summary": "Consented member profile lookup",
        "auth": "client-credentials",
        "scopes": [
          "profile:read"
        ],
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/partner/participation/{partnerId}",
        "summary": "Programme participation (consented members only)",
        "auth": "client-credentials",
        "scopes": [
          "programmes:read"
        ],
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/partner/traceability/shipments/{id}/dds",
        "summary": "Fetch the EUDR due-diligence statement JSON for a shipment. Scope: traceability:read.",
        "auth": "client-credentials",
        "scopes": [
          "traceability:read"
        ],
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/partner/traceability/shipments/{id}/dds/verify",
        "summary": "Recompute the custody hash chain for a shipment. Scope: traceability:read.",
        "auth": "client-credentials",
        "scopes": [
          "traceability:read"
        ],
        "response": "{ 200 }"
      }
    ]
  },
  {
    id: 'partner-writes',
    title: 'Writes',
    description:
      'Mutating federation calls (idempotency-key required).',
    endpoints: [
      {
        "method": "POST",
        "path": "/api/v1/partner/disbursements",
        "summary": "Record a disbursement event (webhook fanned out)",
        "auth": "client-credentials",
        "scopes": [
          "disbursements:write"
        ],
        "response": "{ 201 }"
      },
      {
        "method": "POST",
        "path": "/api/v1/partner/enrolments",
        "summary": "Record a partner programme enrolment",
        "auth": "client-credentials",
        "scopes": [
          "enrolments:write"
        ],
        "response": "{ 201 }"
      },
      {
        "method": "POST",
        "path": "/api/v1/partner/farm-data",
        "summary": "farmOS-compatible farm data push",
        "auth": "client-credentials",
        "scopes": [
          "farm_data:write"
        ],
        "response": "{ 202 }"
      },
      {
        "method": "POST",
        "path": "/api/v1/partner/traceability/shipments",
        "summary": "Create a shipment from commodity lots (exporter). Scope: traceability:write.",
        "auth": "client-credentials",
        "scopes": [
          "traceability:write"
        ],
        "response": "{ 201 }"
      }
    ]
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    description:
      'HMAC-signed outbound event deliveries to subscribed partner URLs.',
    endpoints: [
      {
        "method": "GET",
        "path": "/api/v1/partner/webhooks",
        "summary": "List the client webhook subscriptions (secrets omitted)",
        "auth": "client-credentials",
        "scopes": [
          "webhooks:manage"
        ],
        "response": "{ 200 }"
      },
      {
        "method": "POST",
        "path": "/api/v1/partner/webhooks",
        "summary": "Create a webhook subscription (HMAC-signed deliveries)",
        "auth": "client-credentials",
        "scopes": [
          "webhooks:manage"
        ],
        "response": "{ 201 }"
      },
      {
        "method": "DELETE",
        "path": "/api/v1/partner/webhooks/{id}",
        "summary": "Delete a webhook subscription",
        "auth": "client-credentials",
        "scopes": [
          "webhooks:manage"
        ],
        "response": "{ 200 }"
      }
    ]
  },
  {
    id: 'embeds',
    title: 'Public embed feeds',
    description:
      'Anonymous, read-only JSON feeds backing the embeddable widgets. CORS-open, cache-friendly (60s), and contain no PII.',
    endpoints: [
      {
        "method": "GET",
        "path": "/api/v1/embed/opportunities",
        "summary": "Public opportunity directory for embeds (no PII)",
        "auth": "none",
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/embed/prices",
        "summary": "Latest commodity price observations (ticker feed)",
        "auth": "none",
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/embed/courses",
        "summary": "Course catalogue for embeds (no PII)",
        "auth": "none",
        "response": "{ 200 }"
      },
      {
        "method": "GET",
        "path": "/api/v1/embed/member-cta",
        "summary": "NYFN member registration button configuration",
        "auth": "none",
        "response": "{ 200 }"
      }
    ]
  }
];

/** Flat endpoint list (used by tests and the docs index). */
export function allEndpoints(): CatalogueEndpoint[] {
  return OPENAPI_CATALOGUE.flatMap((section) => section.endpoints);
}
