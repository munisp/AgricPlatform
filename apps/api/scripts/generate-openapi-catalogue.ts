/**
 * Wave P: regenerates apps/web/lib/openapi-catalogue.ts from the live
 * OpenAPI document. NEVER hand-edit the generated output — run:
 *
 *   cd apps/api && npx tsx scripts/generate-openapi-catalogue.ts
 *
 * The developer portal documents the partner + embed surfaces; the
 * generator scopes the full spec to those routes and maps them onto the
 * stable section/auth contract the web app consumes.
 */
import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { buildOpenApiDocument } from '../src/bootstrap.js';

interface OperationObject {
  summary?: string;
  extensions?: Record<string, unknown>;
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

function sectionFor(path: string): string {
  if (path.includes('/partner/oauth/token') || path.includes('/partner/developer-keys')) {
    return 'authentication';
  }
  if (path.includes('/partner/webhooks')) {
    return 'webhooks';
  }
  if (path.startsWith('/api/v1/embed/')) {
    return 'embeds';
  }
  return 'partner';
}

function authFor(path: string): Endpoint['auth'] {
  if (path.includes('/partner/oauth/token')) return 'none';
  if (path.includes('/partner/developer-keys')) return 'user-token';
  if (path.startsWith('/api/v1/embed/')) return 'none';
  return 'client-credentials';
}

async function main(): Promise<void> {
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
      const section = sectionFor(path) === 'partner'
        ? method === 'get'
          ? 'partner-reads'
          : 'partner-writes'
        : sectionFor(path);
      const endpoint: Endpoint = {
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? `${method.toUpperCase()} ${path}`,
        auth: authFor(path),
        ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
        response: `{ ${Object.keys(operation.responses ?? { 200: {} }).join(' | ')} }`
      };
      const list = sections.get(section) ?? [];
      list.push(endpoint);
      sections.set(section, list);
    }
  }

  const order = ['authentication', 'partner-reads', 'partner-writes', 'webhooks', 'embeds'];
  const titles: Record<string, [string, string]> = {
    authentication: [
      'Authentication',
      'Machine-to-machine clients exchange credentials for short-lived access tokens; ' +
        'developers can also issue sandbox API keys from the portal (shown once, stored hashed).'
    ],
    'partner-reads': ['Partner reads', 'Read-only federation queries for authorised partners.'],
    'partner-writes': ['Partner writes', 'Mutating federation calls (idempotency-key required).'],
    webhooks: ['Webhooks', 'HMAC-signed outbound event deliveries to subscribed partner URLs.'],
    embeds: [
      'Public embed feeds',
      'Anonymous, read-only JSON feeds backing the embeddable widgets. CORS-open, cache-friendly, no PII.'
    ]
  };

  const body = order
    .filter((id) => sections.has(id))
    .map((id) => {
      const endpoints = sections
        .get(id)!
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((endpoint) => `      ${JSON.stringify(endpoint, null, 2).replace(/\n/g, '\n      ')}`)
        .join(',\n');
      const [title, description] = titles[id];
      return `  {\n    id: '${id}',\n    title: '${title}',\n    description:\n      '${description}',\n    endpoints: [\n${endpoints}\n    ]\n  }`;
    })
    .join(',\n');

  const output = `/**
 * GENERATED FILE — DO NOT HAND-EDIT.
 * Regenerate with: cd apps/api && npx tsx scripts/generate-openapi-catalogue.ts
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

  const target = new URL('../../../apps/web/lib/openapi-catalogue.ts', import.meta.url);
  await writeFile(target, output);
  console.log(`openapi-catalogue: wrote ${sections.size} sections to ${target.pathname}`);
}

void main();
