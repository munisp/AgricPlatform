import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import type { OutboxSweeperService } from '../../core/outbox-sweeper.service.js';
import { InMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryPartnerMemberRepository } from '../../database/repositories/partner-member.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import type { CommunityService } from '../community/community.service.js';
import type { FinanceService } from '../finance/finance.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import type { PartnerAuthService } from '../partner-api/partner-auth.service.js';
import { UsersService } from '../users/users.service.js';
import { AdminService } from './admin.service.js';

/**
 * OB-07 (privileged-role grant precondition) and OB-17a (admin account
 * provisioning). Seed fixtures: user-adamu is a VERIFIED active farmer;
 * user-aisha is an UNVERIFIED active student.
 */
function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const sessions = createInMemoryAuthSessionRepository();
  const auditRepository = new InMemoryAuditRepository();
  const audit = new AuditService(auditRepository);
  const domainEvents = { publish: async () => ({}) } as unknown as DomainEventsService;
  const stub = {} as never;
  const admin = new AdminService(
    users,
    audit,
    domainEvents,
    stub as CommunityService,
    stub as FinanceService,
    stub as OpportunitiesService,
    stub as LearningService,
    stub as MarketplaceService,
    stub as OutboxSweeperService,
    sessions,
    createInMemoryPartnerMemberRepository()
  );
  return { admin, users, auditRepository };
}

describe('AdminService.setRoles privileged-grant precondition (OB-07)', () => {
  it('rejects a privileged grant to an UNVERIFIED account (400)', async () => {
    const { admin } = build();
    await expect(admin.setRoles('user-aisha', ['student', 'agent'], 'user-admin')).rejects.toThrow(
      BadRequestException
    );
    await expect(admin.setRoles('user-aisha', ['student', 'agent'], 'user-admin')).rejects.toThrow(
      /verified/
    );
  });

  it('rejects ANY role grant to a SUSPENDED account (400)', async () => {
    const { admin, users } = build();
    await users.setStatus('user-adamu', 'suspended');
    await expect(admin.setRoles('user-adamu', ['farmer', 'agent'], 'user-admin')).rejects.toThrow(
      BadRequestException
    );
    // …even a plain self-registration role.
    await expect(admin.setRoles('user-adamu', ['farmer'], 'user-admin')).rejects.toThrow(
      BadRequestException
    );
  });

  it('grants a privileged role to a verified ACTIVE account (200 path)', async () => {
    const { admin } = build();
    const view = await admin.setRoles('user-adamu', ['farmer', 'agent'], 'user-admin');
    expect(view.user.roles).toContain('agent');
    expect(view.accountStatus).toBe('active');
  });

  it('grants self-registration roles to any active account, verified or not', async () => {
    const { admin } = build();
    const view = await admin.setRoles('user-aisha', ['student', 'farmer'], 'user-admin');
    expect(view.user.roles).toEqual(['student', 'farmer']);
  });
});

describe('AdminService.createUser (OB-17a)', () => {
  it('creates the account UNVERIFIED with the requested (privileged) roles', async () => {
    const { admin } = build();
    const view = await admin.createUser(
      {
        phone: '+2348099000001',
        fullName: 'Partner Ops',
        roles: ['partner'],
        preferredLanguage: 'en'
      },
      'user-admin'
    );
    expect(view.user.isVerified).toBe(false);
    expect(view.user.kycTier).toBe('tier_0');
    expect(view.user.roles).toEqual(['partner']);
    expect(view.accountStatus).toBe('active');
  });

  it('audit-records the admin provisioning action', async () => {
    const { admin, auditRepository } = build();
    const view = await admin.createUser(
      {
        phone: '+2348099000002',
        fullName: 'New Agronomist',
        roles: ['agronomist'],
        preferredLanguage: 'ha'
      },
      'user-admin'
    );
    const events = await auditRepository.list();
    const entry = events.find(
      (event) => event.action === 'admin.user.created' && event.entityId === view.user.id
    );
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe('user-admin');
  });

  it('rejects a duplicate phone (conflict surfaces, no shadow account)', async () => {
    const { admin } = build();
    await expect(
      admin.createUser(
        {
          phone: '+2348010000001', // user-adamu's seed phone
          fullName: 'Squatter',
          roles: ['farmer'],
          preferredLanguage: 'en'
        },
        'user-admin'
      )
    ).rejects.toThrow(/already registered/);
  });
});

describe('AdminService.registerPartnerClient (OB-17b)', () => {
  it('fails closed when the partner-auth service is not wired', async () => {
    const { admin } = build();
    await expect(
      admin.registerPartnerClient(
        { name: 'Acme Cooperative', partnerId: 'acme', scopes: ['read:portfolio'] },
        'user-admin'
      )
    ).rejects.toThrow(/not wired/);
  });

  it('registers a tenant-bound partner client and audits it (secret returned once)', async () => {
    const auditRepository = new InMemoryAuditRepository();
    const registered: { clientSecret: string; client: { id: string; partnerId?: string } } = {
      clientSecret: 'pcs_test',
      client: { id: 'pclient-1', partnerId: 'acme' }
    };
    const partnerAuthStub = {
      registerClient: async () => registered
    } as unknown as PartnerAuthService;
    const stub = {} as never;
    const domainEvents = { publish: async () => ({}) } as unknown as DomainEventsService;
    const withPartnerAuth = new AdminService(
      new UsersService(createInMemoryUserRepository()),
      new AuditService(auditRepository),
      domainEvents,
      stub as CommunityService,
      stub as FinanceService,
      stub as OpportunitiesService,
      stub as LearningService,
      stub as MarketplaceService,
      stub as OutboxSweeperService,
      createInMemoryAuthSessionRepository(),
      createInMemoryPartnerMemberRepository(),
      undefined, // chapters
      undefined, // creditProfiles
      undefined, // integrations
      undefined, // auditAnchors
      undefined, // escrowExpirySweeper
      undefined, // voucherStuckSweeper
      partnerAuthStub
    );
    const issued = await withPartnerAuth.registerPartnerClient(
      { name: 'Acme Cooperative', partnerId: 'acme', scopes: ['read:portfolio'] },
      'user-admin'
    );
    expect(issued.clientSecret).toBe('pcs_test');
    expect(issued.client.partnerId).toBe('acme');
    const events = await auditRepository.list();
    expect(
      events.some(
        (event) =>
          event.action === 'admin.partner_client.registered' && event.entityId === 'pclient-1'
      )
    ).toBe(true);
  });
});
