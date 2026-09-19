import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryGuardianLinkRepository,
  InMemoryGuardianLinkRepository,
  type GuardianLink
} from '../../database/repositories/guardian-link.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from './users.service.js';

function build() {
  const links = createInMemoryGuardianLinkRepository();
  // OB-04: the user repo holds the link store so the user-row + link write
  // is one atomic unit (compensated in-memory, single transaction on pg).
  const users = new UsersService(createInMemoryUserRepository(links), links);
  return { users, links };
}

/** Link store whose create always fails — exercises OB-04 atomicity. */
class FailingGuardianLinkRepository extends InMemoryGuardianLinkRepository {
  override async create(): Promise<GuardianLink> {
    throw new Error('guardian_links write failed');
  }
}

describe('UsersService assisted accounts (V-44)', () => {
  it('two farmers share one contact phone with distinct identities (guardian-linked)', async () => {
    const { users } = build();
    const head = await users.create({
      phone: '+2348012345678',
      fullName: 'Household Head',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const assisted = await users.createAssisted(
      {
        fullName: 'Spouse Farmer',
        preferredLanguage: 'ha',
        guardianUserId: head.id,
        relationship: 'spouse',
        presenceProof: { method: 'in_person_attestation', ref: 'att-2026-0001' }
      },
      head
    );
    // Distinct identity rows…
    expect(assisted.user.id).not.toBe(head.id);
    expect(assisted.user.fullName).toBe('Spouse Farmer');
    // …sharing ONE contact phone: the assisted row carries a synthetic
    // internal phone (unique), the real shared phone lives on the link.
    expect(assisted.user.phone).toBe(`assisted:${assisted.user.id}`);
    expect(assisted.link.contactPhone).toBe('+2348012345678');
    expect(assisted.link.kind).toBe('guardian');
    expect(assisted.link.presenceProof.method).toBe('in_person_attestation');
    // The shared phone does NOT collide with the head's account.
    expect(await users.findByPhone('+2348012345678')).toMatchObject({ id: head.id });
    // A second dependent on the same phone works too.
    const second = await users.createAssisted(
      {
        fullName: 'Adult Child',
        preferredLanguage: 'en',
        guardianUserId: head.id,
        relationship: 'child',
        presenceProof: { method: 'in_person_attestation', ref: 'att-2026-0002' }
      },
      head
    );
    expect(second.link.contactPhone).toBe('+2348012345678');
    expect((await users.dependentsOf(head.id)).map((l) => l.dependentUserId).sort()).toEqual(
      [assisted.user.id, second.user.id].sort()
    );
  });

  it('agent-custodied onboarding with presence proof (phoneless farmer)', async () => {
    const { users } = build();
    const agent = await users.create({
      phone: '+2348099999999',
      fullName: 'Field Agent',
      roles: ['agent'],
      preferredLanguage: 'en'
    });
    const { user, link } = await users.createAssisted(
      {
        fullName: 'Phoneless Farmer',
        preferredLanguage: 'yo',
        custodianAgentId: agent.id,
        relationship: 'custody',
        contactPhone: '+2348055555555',
        presenceProof: { method: 'agent_kyc_visit', ref: 'visit-77' }
      },
      agent
    );
    expect(link.kind).toBe('agent_custody');
    expect(link.custodianAgentId).toBe(agent.id);
    expect(link.contactPhone).toBe('+2348055555555');
    expect(user.roles).toEqual(['farmer']);
  });

  it('fails closed: no presence proof, no self-service phone clash, wrong actor, non-agent custodian', async () => {
    const { users } = build();
    const guardian = await users.create({
      phone: '+2348011111111',
      fullName: 'Guardian',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const bystander = await users.create({
      phone: '+2348022222222',
      fullName: 'Bystander',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    // Missing presence proof:
    await expect(
      users.createAssisted(
        {
          fullName: 'Ghost',
          preferredLanguage: 'en',
          guardianUserId: guardian.id,
          relationship: 'child',
          presenceProof: { method: '', ref: '' }
        },
        guardian
      )
    ).rejects.toThrowError(/presenceProof/);
    // Caller is not the guardian (no presence):
    await expect(
      users.createAssisted(
        {
          fullName: 'Ghost',
          preferredLanguage: 'en',
          guardianUserId: guardian.id,
          relationship: 'child',
          presenceProof: { method: 'in_person_attestation', ref: 'x' }
        },
        bystander
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Unauthenticated:
    await expect(
      users.createAssisted(
        {
          fullName: 'Ghost',
          preferredLanguage: 'en',
          guardianUserId: guardian.id,
          relationship: 'child',
          presenceProof: { method: 'm', ref: 'r' }
        },
        null
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Non-agent custodian:
    await expect(
      users.createAssisted(
        {
          fullName: 'Ghost',
          preferredLanguage: 'en',
          custodianAgentId: guardian.id,
          relationship: 'custody',
          presenceProof: { method: 'm', ref: 'r' }
        },
        guardian
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    // XOR gate: both/neither custodian kinds.
    await expect(
      users.createAssisted(
        {
          fullName: 'Ghost',
          preferredLanguage: 'en',
          relationship: 'child',
          presenceProof: { method: 'm', ref: 'r' }
        },
        guardian
      )
    ).rejects.toThrowError(/Exactly one/);
  });

  it('OB-04 atomicity: a failing link write leaves NO user row behind', async () => {
    const links = new FailingGuardianLinkRepository();
    const users = new UsersService(createInMemoryUserRepository(links), links);
    const head = await users.create({
      phone: '+2348077777777',
      fullName: 'Household Head',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    try {
      await users.createAssisted(
        {
          fullName: 'Dependent',
          preferredLanguage: 'en',
          guardianUserId: head.id,
          relationship: 'child',
          presenceProof: { method: 'in_person_attestation', ref: 'att-x' }
        },
        head
      );
      expect.unreachable('link write must fail');
    } catch (error) {
      expect((error as Error).message).toMatch(/guardian_links write failed/);
    }
    // No orphaned assisted identity: the only users are the seeds + head.
    const remaining = (await users.list({ page: 1, pageSize: 100 })).data;
    expect(remaining.filter((u) => u.phone.startsWith('assisted:'))).toEqual([]);
  });

  it('self-service phone uniqueness is unchanged (regression)', async () => {
    const { users } = build();
    await users.create({
      phone: '+2348033333333',
      fullName: 'First',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    await expect(
      users.create({
        phone: '+2348033333333',
        fullName: 'Second',
        roles: ['farmer'],
        preferredLanguage: 'en'
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
