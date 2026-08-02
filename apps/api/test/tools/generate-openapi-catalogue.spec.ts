import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { buildOpenApiDocument } from '../../src/bootstrap.js';

/**
 * Wave P build-time generator: regenerates apps/web/lib/openapi-catalogue.ts
 * from the live OpenAPI document (served at /api/v1/openapi.json). NEVER
 * hand-edit the generated output — run:
 *
 *   cd apps/api && npx vitest run test/tools/generate-openapi-catalogue.spec.ts
 *
 * (vitest+swc is the supported toolchain here: it emits the decorator
 * metadata NestJS DI requires, which plain tsx/esbuild does not.)
 *
 * The developer portal documents the partner + embed surfaces; the
 * generator scopes the full spec to those routes and maps them onto the
 * stable section/auth contract the web app consumes.
 */

interface OperationObject {
  summary?: string;
  'x-partner-scopes'?: string[];
  responses?: Record<string, { description?: string }>;
}

interface Endpoint {
  method: string;
  path: string;
  summary: string;
  auth: 'client-credentials' | 'api-key' | 'user-token' | 'none';
  scopes?: string[];
  requestBody?: string;
  response: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function sectionFor(path: string, method: (typeof METHODS)[number]): string {
  if (path.includes('/partner/oauth/token') || path.includes('/partner/developer-keys')) {
    return 'authentication';
  }
  if (path.includes('/partner/webhooks')) {
    return 'webhooks';
  }
  if (path.startsWith('/api/v1/embed/')) {
    return 'embeds';
  }
  return method === 'get' ? 'partner-reads' : 'partner-writes';
}

function authFor(path: string): Endpoint['auth'] {
  if (path.includes('/partner/oauth/token')) return 'none';
  if (path.includes('/partner/developer-keys')) return 'user-token';
  if (path.startsWith('/api/v1/embed/')) return 'none';
  return 'client-credentials';
}

const SECTION_ORDER = ['authentication', 'partner-reads', 'partner-writes', 'webhooks', 'embeds'];

/** Canonical embed feed order (stable docs contract). */
const EMBED_ORDER = [
  '/api/v1/embed/opportunities',
  '/api/v1/embed/prices',
  '/api/v1/embed/courses',
  '/api/v1/embed/member-cta'
];

const TITLES: Record<string, [string, string]> = {
  authentication: [
    'Authentication',
    'Machine-to-machine clients exchange credentials for short-lived access tokens ' +
      '(audience `partner`, scope claims, 15 minute TTL). Developers can also issue ' +
      'sandbox API keys from the portal; keys are shown once and stored hashed.'
  ],
  'partner-reads': ['Consented reads', 'Read-only federation queries for authorised partners.'],
  'partner-writes': ['Writes', 'Mutating federation calls (idempotency-key required).'],
  webhooks: ['Webhooks', 'HMAC-signed outbound event deliveries to subscribed partner URLs.'],
  embeds: [
    'Public embed feeds',
    'Anonymous, read-only JSON feeds backing the embeddable widgets. CORS-open, ' +
      'cache-friendly (60s), and contain no PII.'
  ]
};

describe('openapi catalogue generator (Wave P)', () => {
  it('regenerates apps/web/lib/openapi-catalogue.ts from the live spec', async () => {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    await app.init();
    const document = buildOpenApiDocument(app);
    await app.close();

    const sections = new Map<string, Endpoint[]>();
    for (const [rawPath, item] of Object.entries(document.paths ?? {})) {
      const path = `/api/v1${rawPath}`;
      if (!path.startsWith('/api/v1/partner/') && !path.startsWith('/api/v1/embed/')) {
        continue;
      }
      for (const method of METHODS) {
        const operation = (item as Record<string, OperationObject>)[method];
        if (!operation) {
          continue;
        }
        const scopes = operation['x-partner-scopes'];
        // The developer portal documents the partner-api surface: scoped
        // routes plus the token/developer-key endpoints. Legacy partner
        // module routes without scope declarations stay out of the catalogue.
        if (
          path.startsWith('/api/v1/partner/') &&
          !path.includes('/partner/oauth/token') &&
          !path.includes('/partner/developer-keys') &&
          (!Array.isArray(scopes) || scopes.length === 0)
        ) {
          continue;
        }
        const endpoint: Endpoint = {
          method: method.toUpperCase(),
          path,
          summary: operation.summary ?? `${method.toUpperCase()} ${path}`,
          auth: authFor(path),
          ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
          response: `{ ${Object.keys(operation.responses ?? { 200: {} }).join(' | ')} }`
        };
        const section = sectionFor(path, method);
        const list = sections.get(section) ?? [];
        list.push(endpoint);
        sections.set(section, list);
      }
    }

    const body = SECTION_ORDER.filter((id) => sections.has(id))
      .map((id) => {
        const endpoints = sections
          .get(id)!
          .sort((a, b) => {
            if (id === 'embeds') {
              return EMBED_ORDER.indexOf(a.path) - EMBED_ORDER.indexOf(b.path);
            }
            return a.path.localeCompare(b.path);
          })
          .map((endpoint) => `      ${JSON.stringify(endpoint, null, 2).replace(/\n/g, '\n      ')}`)
          .join(',\n');
        const [title, description] = TITLES[id];
        return (
          `  {\n    id: '${id}',\n    title: '${title}',\n    description:\n` +
          `      '${description}',\n    endpoints: [\n${endpoints}\n    ]\n  }`
        );
      })
      .join(',\n');

    const output = `/**
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
${body}
];

/** Flat endpoint list (used by tests and the docs index). */
export function allEndpoints(): CatalogueEndpoint[] {
  return OPENAPI_CATALOGUE.flatMap((section) => section.endpoints);
}
`;

    const target = new URL('../../../web/lib/openapi-catalogue.ts', import.meta.url);
    await writeFile(target, output);

    // Contract guardrails (mirrors apps/web/test/openapi-catalogue.test.ts).
    expect([...sections.keys()].sort()).toEqual([...SECTION_ORDER].sort());
  }, 120_000);
});
