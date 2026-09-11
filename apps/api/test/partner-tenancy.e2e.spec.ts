import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

/**
 * Stage-24 tenant-binding regression suite (adopted from the A2 adversarial
 * red tests — every probe below exploited a proven defect; they now assert
 * the fixed, fail-closed behaviour):
 *
 * - A2-1: a `partner`-role caller is bound to its own partner organisation
 *   (partners.partner_members); other partners' routes are 403.
 * - A2-4: programme creation is audit-attributed to the verified caller id,
 *   never the :partnerId path slug.
 * - A2-3: the vsla-carbon GET surface is reachable by authenticated callers
 *   (guard sweep omission fixed) and still rejects anonymous traffic.
 *
 * Seed binding: user-partner (role partner) ↔ 'agri-partner-foundation';
 * user-admin is unrestricted.
 */
describe('Partner tenant binding + channel guards (Stage 24 e2e)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {}
  ) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    let json: unknown = undefined;
    try {
      json = await res.json();
    } catch {
      /* plain-text responses */
    }
    return { status: res.status, body: json };
  }

  const asUser = (id: string) => ({ headers: { 'x-user-id': id } });

  it('A2-a: vsla-carbon GET routes authenticate (200 admin/farmer, 401 anonymous)', async () => {
    const admin = await call('GET', '/vsla-carbon/groups', asUser('user-admin'));
    expect(admin.status).toBe(200);
    const farmer = await call('GET', '/vsla-carbon/coefficients', asUser('user-aisha'));
    expect(farmer.status).toBe(200);
    const anonymous = await call('GET', '/vsla-carbon/groups');
    expect(anonymous.status).toBe(401);
  });

  it('A2-1: partner-role caller cannot create programmes under another partnerId (403)', async () => {
    const created = await call('POST', '/partner/victim-foundation/programmes', {
      ...asUser('user-partner'),
      body: {
        title: 'Cross-tenant write probe',
        type: 'grant',
        description: 'must be refused: user-partner is bound to agri-partner-foundation',
        deadline: '2027-01-01T00:00:00.000Z'
      }
    });
    expect(created.status).toBe(403);
  });

  it('A2-1: partner-role caller cannot read another partner\'s applicant roster (403, no PII)', async () => {
    // A pre-existing partner tenant: admin (unrestricted) creates a programme
    // under partner-real-org and a member applies.
    const created = await call('POST', '/partner/partner-real-org/programmes', {
      ...asUser('user-admin'),
      body: {
        title: 'Victim programme',
        type: 'programme',
        description: 'belongs to partner-real-org',
        deadline: '2027-01-01T00:00:00.000Z'
      }
    });
    expect(created.status).toBe(201);
    const programme = (created.body as { data: { id: string } }).data;
    const apply = await call('POST', `/opportunities/${programme.id}/apply`, {
      ...asUser('user-aisha'),
      body: { userId: 'user-aisha' }
    });
    expect(apply.status).toBe(201);

    // The unrelated partner-role account is refused the roster + PII.
    const res = await call('GET', '/partner/partner-real-org/participants', asUser('user-partner'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('+2348010000004');

    // Programmes + impact report are equally tenant-bound.
    expect((await call('GET', '/partner/partner-real-org/programmes', asUser('user-partner'))).status)
      .toBe(403);
    expect(
      (await call('GET', '/partner/partner-real-org/reports/impact', asUser('user-partner'))).status
    ).toBe(403);
  });

  it('A2-1/A2-4: bound partner acts on its OWN tenant; audit actor is the caller id', async () => {
    const created = await call('POST', '/partner/agri-partner-foundation/programmes', {
      ...asUser('user-partner'),
      body: {
        title: 'Own-tenant programme',
        type: 'grant',
        description: 'user-partner is bound to agri-partner-foundation',
        deadline: '2027-01-01T00:00:00.000Z'
      }
    });
    expect(created.status).toBe(201);
    const programme = (created.body as { data: { id: string; partnerId: string } }).data;
    expect(programme.partnerId).toBe('agri-partner-foundation');

    const own = await call('GET', '/partner/agri-partner-foundation/programmes', asUser('user-partner'));
    expect(own.status).toBe(200);

    const audit = await call('GET', '/admin/audit?actorId=user-partner', asUser('user-admin'));
    expect(audit.status).toBe(200);
    const rows = (audit.body as { data: Array<{ actorId: string; action: string; entityId: string }> })
      .data;
    const row = rows.find(
      (r) => r.action === 'partner.programme.created' && r.entityId === programme.id
    );
    // A2-4: the verified caller, never the path slug.
    expect(row?.actorId).toBe('user-partner');
  });

  it('A2-1: admin-managed bind/unbind operates the tenant binding (audited)', async () => {
    // A partner-role caller cannot self-bind (admin-only surface).
    const selfBind = await call(
      'PUT',
      '/admin/users/user-partner/partner-memberships/partner-real-org',
      asUser('user-partner')
    );
    expect(selfBind.status).toBe(403);

    // Admin binds user-partner → partner-real-org; access opens.
    const bind = await call(
      'PUT',
      '/admin/users/user-partner/partner-memberships/partner-real-org',
      asUser('user-admin')
    );
    expect(bind.status).toBe(200);
    expect(
      (await call('GET', '/partner/partner-real-org/participants', asUser('user-partner'))).status
    ).toBe(200);
    const listed = await call('GET', '/admin/partner-memberships?userId=user-partner', asUser('user-admin'));
    const memberships = (listed.body as { data: Array<{ partnerId: string }> }).data;
    expect(memberships.map((m) => m.partnerId)).toContain('partner-real-org');

    // Unbind closes it again (fail closed).
    const unbind = await call(
      'DELETE',
      '/admin/users/user-partner/partner-memberships/partner-real-org',
      asUser('user-admin')
    );
    expect(unbind.status).toBe(200);
    expect(
      (await call('GET', '/partner/partner-real-org/participants', asUser('user-partner'))).status
    ).toBe(403);
  });

  it('partner routes reject anonymous callers (401)', async () => {
    expect((await call('GET', '/partner/agri-partner-foundation/programmes')).status).toBe(401);
  });
});
