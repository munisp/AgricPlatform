import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { OutboxSweeperService } from '../../core/outbox-sweeper.service.js';
import {
  AUTH_SESSION_REPOSITORY,
  PARTNER_MEMBER_REPOSITORY
} from '../../database/persistence.tokens.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryPartnerMemberRepository } from '../../database/repositories/partner-member.repository.js';
import { createInMemoryPartnerClientRepository } from '../../database/repositories/partner-api.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from '../users/users.service.js';
import { PartnerAuthService } from '../partner-api/partner-auth.service.js';
import { AdminService } from './admin.service.js';

/**
 * OB-17: admin provisioning paths — direct user creation (17a, unverified,
 * OTP on first login) and partner-organisation client provisioning (17b,
 * tenant-bound, one-time secret).
 */
function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const audit = new AuditService(createInMemoryAuditRepository());
  const domainEvents = new DomainEventsService(createInMemoryOutboxRepository());
  const partnerAuth = new PartnerAuthService(createInMemoryPartnerClientRepository());
  const admin = new AdminService(
    users,
    audit,
    domainEvents,
    {} as never, // community
    {} as never, // finance
    {} as never, // opportunities
    {} as never, // learning
    {} as never, // marketplace
    {} as unknown as OutboxSweeperService,
    createInMemoryAuthSessionRepository(),
    createInMemoryPartnerMemberRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    partnerAuth
  );
  return { admin, users, audit, domainEvents, partnerAuth };
}

describe('AdminService.createUser (OB-17a)', () => {
  it('creates the account UNVERIFIED at tier_0, audited and evented', async () => {
    const { admin, users, audit, domainEvents } = build();
    const view = await admin.createUser(
      {
        phone: '+2348060000001',
        fullName: 'Provisioned Agent',
        roles: ['agent'],
        preferredLanguage: 'en'
      },
      'user-admin'
    );
    expect(view.user.isVerified).toBe(false);
    expect(view.user.kycTier).toBe('tier_0');
    expect(view.user.roles).toEqual(['agent']);
    expect(view.accountStatus).toBe('active');
    // Privileged roles cannot take effect before OTP verification (OB-07):
    // the account itself starts unverified, and setRoles re-checks.
    await expect(
      admin.setRoles(view.user.id, ['admin'], 'user-admin')
    ).rejects.toThrowError(/OTP-verified/);
    await users.setVerified(view.user.id, true);
    await expect(admin.setRoles(view.user.id, ['admin'], 'user-admin')).resolves.toMatchObject({
      user: { roles: ['admin'] }
    });
    const actions = (await audit.list({})).map((entry) => entry.action);
    expect(actions).toContain('admin.user.created');
    const outbox = await domainEvents.listOutbox();
    expect(outbox.map((event) => event.name)).toContain('identity.user.created');
  });
});

describe('AdminService.registerPartnerClient (OB-17b)', () => {
  it('issues a tenant-bound client, returns the secret once, audits without the secret', async () => {
    const { admin, partnerAuth, audit } = build();
    const issued = await admin.registerPartnerClient(
      { name: 'BOI Partner', scopes: ['members:read'], partnerId: 'boi' },
      'user-admin'
    );
    expect(issued.clientSecret).toMatch(/^agpc_/);
    expect(issued.client.partnerId).toBe('boi');
    // Only the hash is persisted: authenticating with the plaintext works,
    // the stored record never contains it.
    const auth = await partnerAuth.authenticate(issued.client.clientId, issued.clientSecret);
    expect(auth.client.id).toBe(issued.client.id);
    expect(JSON.stringify(await audit.list({}))).not.toContain(issued.clientSecret);
    const actions = (await audit.list({})).map((entry) => entry.action);
    expect(actions).toContain('admin.partner_client.registered');
  });
});

describe('AdminService.setRoles verification gate (OB-07)', () => {
  it('refuses privileged grants to unverified accounts and any grant to suspended ones', async () => {
    const { admin, users } = build();
    const target: User = await users.create({
      phone: '+2348060000002',
      fullName: 'Gate Target',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    // Unverified: privileged grant refused, plain grant allowed.
    await expect(admin.setRoles(target.id, ['admin'], 'user-admin')).rejects.toThrowError(
      /OTP-verified/
    );
    await expect(
      admin.setRoles(target.id, ['farmer', 'buyer'], 'user-admin')
    ).resolves.toMatchObject({ user: { roles: ['farmer', 'buyer'] } });
    // Suspended: even plain grants are refused.
    await admin.setStatus(target.id, 'suspended', 'user-admin');
    await expect(admin.setRoles(target.id, ['farmer'], 'user-admin')).rejects.toThrowError(
      /suspended/
    );
  });
});

describe('AdminModule wiring (OB-17b)', () => {
  it('resolves AdminService with PartnerAuthService via the module graph', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [(await import('./admin.module.js')).AdminModule]
    })
      .overrideProvider(AUTH_SESSION_REPOSITORY)
      .useValue(createInMemoryAuthSessionRepository())
      .overrideProvider(PARTNER_MEMBER_REPOSITORY)
      .useValue(createInMemoryPartnerMemberRepository())
      .compile();
    const admin = moduleRef.get(AdminService);
    expect(admin).toBeInstanceOf(AdminService);
    await moduleRef.close();
  });
});
