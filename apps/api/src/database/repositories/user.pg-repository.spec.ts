import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { User } from '@agric-platform/shared';
import type { GuardianLink } from './guardian-link.repository.js';
import { PgUserRepository } from './user.pg-repository.js';

/**
 * OB-04 query-spy tests: createWithGuardianLink must wrap the identity.users
 * (+ user_roles) insert and the identity.guardian_links insert in ONE
 * transaction on a single pooled client, so a link-write failure rolls the
 * user row back (no orphaned assisted identity).
 */

const user: User = {
  id: 'user-assisted-1',
  phone: 'assisted:user-assisted-1',
  fullName: 'Phoneless Farmer',
  roles: ['farmer'],
  preferredLanguage: 'en',
  kycTier: 'tier_0',
  isVerified: false,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const link: GuardianLink = {
  id: 'guardianlink-1',
  dependentUserId: user.id,
  guardianUserId: 'user-guardian-1',
  kind: 'guardian',
  relationship: 'spouse',
  contactPhone: '+2348012345678',
  presenceProof: {
    method: 'in_person_attestation',
    ref: 'att-1',
    attestedAt: '2026-01-01T00:00:00.000Z'
  },
  createdAt: '2026-01-01T00:00:00.000Z'
};

interface RecordedQuery {
  text: string;
  params?: unknown[];
}

function spyPool(failOn?: RegExp) {
  const queries: RecordedQuery[] = [];
  let released = false;
  const client = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (failOn && failOn.test(text)) {
        throw new Error('simulated guardian_links write failure');
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {
      released = true;
    }
  } as unknown as pg.PoolClient;
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, queries, isReleased: () => released };
}

describe('PgUserRepository.createWithGuardianLink (OB-04)', () => {
  it('commits user row, role rows and guardian link in ONE transaction on ONE client', async () => {
    const { pool, queries, isReleased } = spyPool();
    const repo = new PgUserRepository(pool);

    const result = await repo.createWithGuardianLink(user, link);

    expect(result.user.id).toBe(user.id);
    expect(result.link.id).toBe(link.id);
    const statements = queries.map((q) => q.text);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.some((s) => s.includes('INSERT INTO identity.users'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO identity.user_roles'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO identity.guardian_links'))).toBe(true);
    expect(statements.some((s) => s === 'ROLLBACK')).toBe(false);
    expect(isReleased()).toBe(true);
  });

  it('rolls back the user insert when the guardian-link insert fails', async () => {
    const { pool, queries, isReleased } = spyPool(/identity\.guardian_links/);
    const repo = new PgUserRepository(pool);

    await expect(repo.createWithGuardianLink(user, link)).rejects.toThrow(
      /guardian_links write failure/
    );

    const statements = queries.map((q) => q.text);
    // The user insert was attempted but the transaction was rolled back…
    expect(statements.some((s) => s.includes('INSERT INTO identity.users'))).toBe(true);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((s) => s === 'COMMIT')).toBe(false);
    expect(isReleased()).toBe(true);
  });
});
