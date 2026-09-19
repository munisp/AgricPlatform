import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PartnerAuthService } from '../src/modules/partner-api/partner-auth.service.js';

/**
 * Partner API wave P5d end-to-end: client-credentials token flow, scope
 * enforcement (401/403), developer API keys and the anonymous embed feeds.
 */
describe('Partner API (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;
  let clientId: string;
  let clientSecret: string;
  let otherClientId: string;
  let otherClientSecret: string;
  let limitedClientId: string;
  let limitedClientSecret: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.PARTNER_API_DRIVER = 'sandbox';
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;

    const auth = app.get(PartnerAuthService);
    // Tenant binding (Stage 24, audit A2-2): every client is bound to ONE
    // partner organisation at registration; tokens carry the binding.
    const full = await auth.registerClient({
      name: 'E2E Partner',
      scopes: [
        'programmes:read',
        'impact:read',
        'applications:read',
        'disbursements:write',
        'enrolments:write',
        'webhooks:manage',
        'profile:read',
        'farm_data:write'
      ],
      partnerId: 'partner-demo'
    });
    clientId = full.client.clientId;
    clientSecret = full.clientSecret;

    const other = await auth.registerClient({
      name: 'Other Partner',
      scopes: ['programmes:read', 'impact:read', 'disbursements:write'],
      partnerId: 'partner-other'
    });
    otherClientId = other.client.clientId;
    otherClientSecret = other.clientSecret;

    const limited = await auth.registerClient({
      name: 'Narrow',
      scopes: ['impact:read'],
      partnerId: 'partner-demo'
    });
    limitedClientId = limited.client.clientId;
    limitedClientSecret = limited.clientSecret;

    // Member-binding fixtures (Stage 27, WP-G22 follow-up): a disbursement
    // subject must be a member of the partner's scope — an application to
    // one of that partner's programmes, or an explicit active sharing
    // consent. The seed farmer is bound to BOTH partner tenants via
    // programme applications (deliberately NOT via consent records: the
    // member-profile 403 test depends on user-adamu holding no
    // partner_data_sharing consent).
    async function createOpportunity(partnerId: string, title: string): Promise<string> {
      const res = await fetch(`${base}/opportunities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user-admin' },
        body: JSON.stringify({
          title,
          type: 'loan',
          description: 'Member-binding e2e fixture facility.',
          states: ['Kano'],
          valueChains: ['Cassava'],
          eligibility: ['Tier 1 KYC'],
          deadline: '2027-01-31T23:59:59.000Z',
          partnerId
        })
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string } };
      return body.data.id;
    }
    async function applyAs(userId: string, opportunityId: string): Promise<void> {
      const res = await fetch(`${base}/opportunities/${opportunityId}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ userId })
      });
      expect(res.status).toBe(201);
    }
    const demoOpportunity = await createOpportunity('partner-demo', 'E2E Demo Facility');
    const otherOpportunity = await createOpportunity('partner-other', 'E2E Other Facility');
    await applyAs('user-adamu', demoOpportunity);
    await applyAs('user-adamu', otherOpportunity);
    // Bound to partner-demo only — the cross-partner rejection subject.
    await applyAs('user-farmer-2', demoOpportunity);
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...savedEnv };
  });

  async function tokenFor(id: string, secret: string): Promise<string> {
    const res = await fetch(`${base}/partner/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; sandbox: boolean };
    expect(body.sandbox).toBe(true);
    return body.access_token;
  }

  it('issues a client-credentials access token', async () => {
    const res = await fetch(`${base}/partner/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toContain('impact:read');
  });

  it('rejects a bad client secret with 401', async () => {
    const res = await fetch(`${base}/partner/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: 'pcs_wrong'
      })
    });
    expect(res.status).toBe(401);
  });

  it('serves scoped reads with a valid token', async () => {
    const token = await tokenFor(clientId, clientSecret);
    const res = await fetch(`${base}/partner/impact/partner-demo`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { partnerId: string; applications: number } };
    expect(body.data.partnerId).toBe('partner-demo');
    expect(typeof body.data.applications).toBe('number');
  });

  it('denies out-of-scope calls with 403', async () => {
    const token = await tokenFor(limitedClientId, limitedClientSecret);
    // limited client only holds impact:read; disbursements:write must fail.
    const res = await fetch(`${base}/partner/disbursements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ partnerId: 'p', userId: 'user-adamu', amountNgn: 100 })
    });
    expect(res.status).toBe(403);
  });

  it('rejects missing/invalid tokens with 401', async () => {
    expect((await fetch(`${base}/partner/impact/p`)).status).toBe(401);
    const res = await fetch(`${base}/partner/impact/p`, {
      headers: { authorization: 'Bearer not-a-token' }
    });
    expect(res.status).toBe(401);
  });

  it('records a disbursement with the write scope', async () => {
    const token = await tokenFor(clientId, clientSecret);
    const res = await fetch(`${base}/partner/disbursements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        partnerId: 'partner-demo',
        userId: 'user-adamu',
        amountNgn: 75_000,
        reference: 'e2e-1'
      })
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; amountNgn: number } };
    expect(body.data.amountNgn).toBe(75_000);
  });

  it('scopes tenant-parameterised reads to the bound partnerId (Stage 24, audit A2-2)', async () => {
    const token = await tokenFor(otherClientId, otherClientSecret);
    // Bound to partner-other: its own tenant reads fine...
    const own = await fetch(`${base}/partner/impact/partner-other`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(own.status).toBe(200);
    // ...but any other partner's tenant is refused (403).
    for (const path of [
      '/partner/impact/partner-demo',
      '/partner/participation/partner-demo',
      '/partner/applications/count/partner-demo'
    ]) {
      const res = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(403);
    }
  });

  it('persists the TOKEN partnerId on writes; 400 on caller-supplied mismatch (A2-2)', async () => {
    const token = await tokenFor(otherClientId, otherClientSecret);
    // Caller-supplied partnerId contradicting the token binding → 400.
    const mismatch = await fetch(`${base}/partner/disbursements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ partnerId: 'partner-demo', userId: 'user-adamu', amountNgn: 10 })
    });
    expect(mismatch.status).toBe(400);

    // partnerId omitted → recorded under the token's bound partnerId.
    const recorded = await fetch(`${base}/partner/disbursements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: 'user-adamu', amountNgn: 25 })
    });
    expect(recorded.status).toBe(201);
    const body = (await recorded.json()) as { data: { partnerId: string } };
    expect(body.data.partnerId).toBe('partner-other');
  });

  it('manages webhook subscriptions (secret shown once, omitted on list)', async () => {
    const token = await tokenFor(clientId, clientSecret);
    const created = await fetch(`${base}/partner/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventTypes: ['disbursement.recorded'],
        // V-59: registration runs the DNS-resolving SSRF guard (fail closed).
        // A literal public IP skips resolution, so the e2e needs no DNS stub
        // (@nestjs/testing is not a dependency, so no provider override).
        targetUrl: 'https://93.184.216.34/hook',
        secret: 'sixteen-char-secret'
      })
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string; secret: string } };
    expect(createdBody.data.secret).toBe('sixteen-char-secret');

    const listed = await fetch(`${base}/partner/webhooks`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const listedBody = (await listed.json()) as { data: Array<Record<string, unknown>> };
    expect(listedBody.data).toHaveLength(1);
    expect(listedBody.data[0]).not.toHaveProperty('secret');

    const removed = await fetch(`${base}/partner/webhooks/${createdBody.data.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(removed.status).toBe(200);
  });

  it('denies member profile reads without consent (403)', async () => {
    const token = await tokenFor(clientId, clientSecret);
    const res = await fetch(`${base}/partner/members/user-adamu/profile`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('issues a developer API key via the portal flow and accepts it as x-api-key', async () => {
    // OB-08: key issuance is admin/partner-only — a farmer member is 403…
    const asFarmer = await fetch(`${base}/partner/developer-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user-adamu' },
      body: JSON.stringify({ scopes: ['impact:read'] })
    });
    expect(asFarmer.status).toBe(403);
    // …unknown scope strings are a 400 (whitelisted against the scopes the
    // partner routes actually consume)…
    const unknownScope = await fetch(`${base}/partner/developer-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user-admin' },
      body: JSON.stringify({ scopes: ['impact:read', 'admin:everything'] })
    });
    expect(unknownScope.status).toBe(400);
    // …and an admin can issue a key for a real scope.
    const issued = await fetch(`${base}/partner/developer-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user-admin' },
      body: JSON.stringify({ scopes: ['impact:read'] })
    });
    expect(issued.status).toBe(201);
    const body = (await issued.json()) as { data: { key: string; prefix: string; sandbox: boolean } };
    expect(body.data.key.startsWith('ak_sandbox_')).toBe(true);
    expect(body.data.sandbox).toBe(true);

    const res = await fetch(`${base}/partner/impact/partner-demo`, {
      headers: { 'x-api-key': body.data.key }
    });
    // Developer keys carry no tenant binding (Stage 24, audit A2-2):
    // tenant-parameterised routes fail closed for them.
    expect(res.status).toBe(403);
  });

  it('serves anonymous embed feeds with open CORS and cache headers', async () => {
    for (const path of ['opportunities', 'prices', 'courses', 'member-cta']) {
      const res = await fetch(`${base}/embed/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('cache-control')).toContain('public');
      const body = (await res.json()) as { data: unknown };
      expect(body.data).toBeDefined();
    }
  });

  it('binds disbursement subjects to the partner programme scope (Stage 27, WP-G22 follow-up)', async () => {
    const demoToken = await tokenFor(clientId, clientSecret);
    const otherToken = await tokenFor(otherClientId, otherClientSecret);
    const disburse = (token: string, userId: string) =>
      fetch(`${base}/partner/disbursements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId, amountNgn: 12_000 })
      });

    // Application-bound member (user-farmer-2 applied to a partner-demo
    // facility in beforeAll): the owning partner may record a disbursement.
    const allowed = await disburse(demoToken, 'user-farmer-2');
    expect(allowed.status).toBe(201);
    const allowedBody = (await allowed.json()) as { data: { partnerId: string } };
    expect(allowedBody.data.partnerId).toBe('partner-demo');

    // Cross-partner: user-farmer-2 is bound to partner-demo only, so the
    // other partner's client is refused (404, never silently allowed).
    const crossPartner = await disburse(otherToken, 'user-farmer-2');
    expect(crossPartner.status).toBe(404);

    // An existing but unbound user and an unknown user are refused with the
    // same 404 shape, so membership cannot be enumerated (WP-G4 convention).
    const unbound = await disburse(demoToken, 'user-aisha');
    const ghost = await disburse(demoToken, 'user-ghost');
    expect(unbound.status).toBe(404);
    expect(ghost.status).toBe(404);
    const unboundBody = (await unbound.json()) as { message: string };
    const ghostBody = (await ghost.json()) as { message: string };
    expect(unboundBody.message).toBe(ghostBody.message.replace('user-ghost', 'user-aisha'));
  });
});
