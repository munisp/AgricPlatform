import { describe, expect, it } from 'vitest';
import { AuditService } from '../../../core/audit.service.js';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import { createInMemoryAuditRepository } from '../../../database/repositories/audit.repository.js';
import { createInMemoryOutboxRepository } from '../../../database/repositories/outbox.repository.js';
import { createInMemoryExternalAccountLinkRepository } from '../../../database/repositories/phase3.repository.js';
import { createInMemoryUserRepository } from '../../../database/repositories/user.repository.js';
import { seedUsers } from '../../../database/seed-data.js';
import { ExternalAccountsService } from './external-accounts.service.js';

function setup() {
  const links = createInMemoryExternalAccountLinkRepository();
  const service = new ExternalAccountsService(
    links,
    createInMemoryUserRepository(),
    new AuditService(createInMemoryAuditRepository()),
    new DomainEventsService(createInMemoryOutboxRepository())
  );
  return { links, service };
}

const validInput = {
  system: 'farmos' as const,
  externalId: 'farm-42',
  consentAt: '2026-05-01T09:00:00.000Z'
};

describe('ExternalAccountsService', () => {
  it('links an external account with a consent timestamp', async () => {
    const { service } = setup();
    const link = await service.link(seedUsers[0].id, validInput);
    expect(link).toMatchObject({
      userId: seedUsers[0].id,
      system: 'farmos',
      externalId: 'farm-42',
      consentAt: '2026-05-01T09:00:00.000Z'
    });
    expect(link.revokedAt).toBeUndefined();
  });

  it('rejects linking without a valid consentAt (consent-gated)', async () => {
    const { service } = setup();
    await expect(service.link(seedUsers[0].id, { ...validInput, consentAt: '' })).rejects.toThrow(
      /consentAt/
    );
    await expect(
      service.link(seedUsers[0].id, { ...validInput, consentAt: 'not-a-date' })
    ).rejects.toThrow(/consentAt/);
  });

  it('rejects unsupported systems', async () => {
    const { service } = setup();
    await expect(
      service.link(seedUsers[0].id, { ...validInput, system: 'agritok' as 'farmos' })
    ).rejects.toThrow(/Unsupported external system/);
  });

  it('is idempotent on re-link of the same account', async () => {
    const { service, links } = setup();
    const first = await service.link(seedUsers[0].id, validInput);
    const second = await service.link(seedUsers[0].id, validInput);
    expect(second.id).toBe(first.id);
    expect(await links.all()).toHaveLength(1);
  });

  it('soft-revokes on unlink and blocks other users', async () => {
    const { service } = setup();
    const link = await service.link(seedUsers[0].id, validInput);
    await expect(service.unlink(seedUsers[1].id, link.id)).rejects.toThrow(/own external accounts/);
    const revoked = await service.unlink(seedUsers[0].id, link.id);
    expect(revoked.revokedAt).toBeTruthy();
    // Idempotent unlink.
    const again = await service.unlink(seedUsers[0].id, link.id);
    expect(again.revokedAt).toBe(revoked.revokedAt);
    // Active-only listing excludes the revoked link.
    expect(await service.listFor(seedUsers[0].id)).toHaveLength(1);
  });
});
