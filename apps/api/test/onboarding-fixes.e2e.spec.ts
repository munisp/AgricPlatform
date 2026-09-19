import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

/**
 * Onboarding-gap fixes (OB-04 / OB-05 / OB-07 / OB-17) against a real HTTP
 * listener in in-memory persistence mode. Dev-header auth (x-user-id) is
 * what the other e2e suites use.
 *
 * Seed actors: user-admin (admin, verified), user-adamu (farmer, verified),
 * user-aisha (student, UNVERIFIED), user-hassan (supplier, verified),
 * user-buyer (buyer, verified).
 */
describe('Onboarding fixes (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;

  const admin = { 'x-user-id': 'user-admin' };

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
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    return fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  }

  describe('OB-04: POST /users/assisted (guardian/phoneless onboarding)', () => {
    const payload = {
      fullName: 'Phoneless Farmer',
      preferredLanguage: 'ha',
      custodianAgentId: 'user-adamu',
      relationship: 'custody',
      presenceProof: { method: 'agent_kyc_visit', ref: 'visit-e2e-1' }
    };

    it('401 unauthenticated, 403 for a plain self-service role', async () => {
      expect((await call('POST', '/users/assisted', payload)).status).toBe(401);
      expect(
        (await call('POST', '/users/assisted', payload, { 'x-user-id': 'user-buyer' })).status
      ).toBe(403);
    });

    it('201 for an agent actor; presence proof enforced (400 without it)', async () => {
      // Make user-adamu an agent first (verified + active → OB-07 allows).
      const grant = await call(
        'PATCH',
        '/admin/users/user-adamu/roles',
        { roles: ['farmer', 'agent'] },
        admin
      );
      expect(grant.status).toBe(200);

      // Presence-proof validation (service gate, via the endpoint).
      const noProof = await call(
        'POST',
        '/users/assisted',
        { ...payload, presenceProof: { method: '', ref: '' } },
        { 'x-user-id': 'user-adamu' }
      );
      expect(noProof.status).toBe(400);

      const created = await call('POST', '/users/assisted', payload, { 'x-user-id': 'user-adamu' });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.data.user.phone).toBe(`assisted:${body.data.user.id}`);
      expect(body.data.user.isVerified).toBe(false);
      expect(body.data.link.kind).toBe('agent_custody');
      expect(body.data.link.custodianAgentId).toBe('user-adamu');
      expect(body.data.link.contactPhone).toBe('+2348010000001');
    });
  });

  describe('OB-07: privileged role grants require active + verified targets', () => {
    it('400 granting a privileged role to an UNVERIFIED user', async () => {
      const res = await call(
        'PATCH',
        '/admin/users/user-aisha/roles',
        { roles: ['student', 'agent'] },
        admin
      );
      expect(res.status).toBe(400);
    });

    it('400 granting roles to a SUSPENDED user', async () => {
      const suspend = await call(
        'PATCH',
        '/admin/users/user-hassan/status',
        { status: 'suspended' },
        admin
      );
      expect(suspend.status).toBe(200);
      const res = await call(
        'PATCH',
        '/admin/users/user-hassan/roles',
        { roles: ['supplier', 'agent'] },
        admin
      );
      expect(res.status).toBe(400);
    });

    it('200 granting a privileged role to a verified active user', async () => {
      const res = await call(
        'PATCH',
        '/admin/users/user-lead-kaduna/roles',
        { roles: ['chapter_lead', 'enumerator'] },
        admin
      );
      expect(res.status).toBe(200);
    });

    it('200 granting self-registration roles to an unverified but active user', async () => {
      const res = await call(
        'PATCH',
        '/admin/users/user-aisha/roles',
        { roles: ['student', 'farmer'] },
        admin
      );
      expect(res.status).toBe(200);
    });
  });

  describe('OB-17a: POST /admin/users (admin provisioning)', () => {
    it('403 for a non-admin, 401 unauthenticated', async () => {
      const body = {
        phone: '+2348099000101',
        fullName: 'Nope',
        roles: ['farmer'],
        preferredLanguage: 'en'
      };
      expect((await call('POST', '/admin/users', body)).status).toBe(401);
      expect((await call('POST', '/admin/users', body, { 'x-user-id': 'user-buyer' })).status).toBe(
        403
      );
    });

    it('creates an UNVERIFIED user with the requested privileged roles and audits it', async () => {
      const res = await call(
        'POST',
        '/admin/users',
        {
          phone: '+2348099000100',
          fullName: 'Provisioned Partner',
          roles: ['partner'],
          preferredLanguage: 'en'
        },
        admin
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.user.isVerified).toBe(false);
      expect(body.data.user.roles).toEqual(['partner']);
      expect(body.data.accountStatus).toBe('active');

      const audit = await (
        await call('GET', '/admin/audit?entityType=user', undefined, admin)
      ).json();
      expect(
        audit.data.some(
          (event: { action: string; entityId: string }) =>
            event.action === 'admin.user.created' && event.entityId === body.data.user.id
        )
      ).toBe(true);
    });

    it('400 on a non-E.164 phone', async () => {
      const res = await call(
        'POST',
        '/admin/users',
        { phone: '08012345678', fullName: 'Bad Phone', roles: ['farmer'], preferredLanguage: 'en' },
        admin
      );
      expect(res.status).toBe(400);
    });
  });

  describe('OB-17b: POST /admin/partner-clients (partner-org provisioning)', () => {
    it('registers a tenant-bound partner client (secret returned once) and audits it', async () => {
      const res = await call(
        'POST',
        '/admin/partner-clients',
        { name: 'Acme Cooperative', partnerId: 'acme-e2e', scopes: ['read:portfolio'] },
        admin
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.client.partnerId).toBe('acme-e2e');
      expect(typeof body.data.client.clientSecretHash).toBe('string');
      expect(body.data.clientSecret).toMatch(/^pcs_/);

      const audit = await (
        await call('GET', '/admin/audit?entityType=partner_client', undefined, admin)
      ).json();
      expect(
        audit.data.some(
          (event: { action: string; entityId: string }) =>
            event.action === 'admin.partner_client.registered' &&
            event.entityId === body.data.client.id
        )
      ).toBe(true);
    });

    it('403 for a non-admin', async () => {
      const res = await call(
        'POST',
        '/admin/partner-clients',
        { name: 'Nope', partnerId: 'nope', scopes: ['read:portfolio'] },
        { 'x-user-id': 'user-buyer' }
      );
      expect(res.status).toBe(403);
    });
  });

  describe('OB-05: agent activation grants the agent role', () => {
    it('PENDING registration has no role; ACTIVATION grants it', async () => {
      // Provision a plain user to register as an agent.
      const provisioned = await (
        await call(
          'POST',
          '/admin/users',
          {
            phone: '+2348099000200',
            fullName: 'Prospective Agent',
            roles: ['farmer'],
            preferredLanguage: 'en'
          },
          admin
        )
      ).json();
      const userId = provisioned.data.user.id as string;

      const registered = await call(
        'POST',
        '/agent-banking/agents',
        { userId, organisation: 'Kano Farmers Cooperative' },
        admin
      );
      expect(registered.status).toBe(201);
      const agentId = (await registered.json()).data.id as string;

      const findDirectoryEntry = async (id: string) => {
        for (let page = 1; page <= 10; page += 1) {
          const directory = await (
            await call('GET', `/admin/users?page=${page}&pageSize=100`, undefined, admin)
          ).json();
          const entry = directory.data.data.find(
            (row: { user: { id: string } }) => row.user.id === id
          );
          if (entry) return entry;
          if (page * 100 >= directory.data.total) break;
        }
        return undefined;
      };

      // Still just a farmer while PENDING.
      let entry = await findDirectoryEntry(userId);
      expect(entry?.user.roles).toEqual(['farmer']);

      const activated = await call(
        'PATCH',
        `/agent-banking/agents/${agentId}/status`,
        { status: 'ACTIVE' },
        admin
      );
      expect(activated.status).toBe(200);

      entry = await findDirectoryEntry(userId);
      expect(entry?.user.roles).toContain('agent');
    });
  });
});
